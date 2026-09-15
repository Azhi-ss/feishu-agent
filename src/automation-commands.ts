// feishu automation command handlers (slice 1 #39, slice 2 #40, recurrence #41,
// full management lifecycle #42). Structured results go to stdout as one JSON
// object; English diagnostics and interactive confirmation go to stderr. All
// file writes happen only after complete validation and, for execution-
// affecting edits, affirmative confirmation.

import { existsSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  AutomationError,
  DEFAULT_LATENESS_MINUTES,
  DEFAULT_TIMEZONE,
  DEFAULT_TIMEOUT_MINUTES,
  activeRun,
  discardPendingOccurrences,
  ensureWorkspace,
  createdFloorMs,
  latestDueOccurrence,
  listJobs,
  loadJob,
  loadScheduleState,
  managedWorkspaceHome,
  mutateJobRecord,
  nextOccurrence,
  nextOccurrenceAfterFloor,
  nowMs,
  occurrenceDeadline,
  parseCronSchedule,
  parseDurationMinutes,
  parseInterval,
  parseOneShot,
  pruneRetainedArtifacts,
  publishCancelRequest,
  recordedFloor,
  resolveLarkProfile,
  resolveScheduleLabel,
  saveJob,
  scheduleEligibilityNotice,
  withLifecycleLock,
  workspacePaths,
  validateName,
  type JobRecord,
  type OccurrenceState,
  type OneShotSchedule,
  type Schedule,
} from "./automation.js";
import { runJobManual } from "./automation-runner.js";
import { liveTrigger, serve as serveTrigger } from "./automation-trigger.js";
import { rmSync } from "node:fs";

const RECURSION_NOTICE = "Automation management is disabled inside an inherited unattended run (loop prevention). Run this command from an ordinary Feishu session.";

interface PlanInput {
  name: string;
  at?: string;
  cron?: string;
  every?: string;
  timeZone: string;
  timeoutMinutes: number;
  catchUpRaw?: string;
  noCatchUp: boolean;
  task: string;
  profile: string;
  yes: boolean;
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function readTaskValue(args: string[], required: boolean): string | undefined {
  const file = flagValue(args, "--prompt-file");
  if (file && args.includes("--prompt-stdin")) fail("Use either --prompt-file or --prompt-stdin, not both.");
  if (file) {
    try {
      const task = readFileSync(file, "utf8");
      if (!task.trim()) fail(`Task instructions in ${file} are empty.`);
      return task;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") fail(`Cannot read task file: ${file}`);
      throw error;
    }
  }
  if (args.includes("--prompt-stdin")) {
    // stdin must remain a TTY for the confirmation prompt; on a TTY use
    // --prompt-file instead. Reading stdin to EOF before confirming would hang.
    if (process.stdin.isTTY) {
      fail("Provide task instructions with --prompt-file <path> when running interactively; --prompt-stdin requires piped input and explicit --yes.");
    }
    const chunks: Buffer[] = [];
    const fd = 0;
    try {
      let bytesRead: number;
      const buffer = Buffer.alloc(65536);
      do {
        bytesRead = readSync(fd, buffer, 0, buffer.length, null);
        if (bytesRead > 0) chunks.push(buffer.subarray(0, bytesRead));
      } while (bytesRead > 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
    }
    const task = Buffer.concat(chunks).toString("utf8");
    if (!task.trim()) fail("Task instructions from stdin are empty; provide nonempty task instructions.");
    return task;
  }
  if (required) fail("Provide task instructions with --prompt-file <path> or --prompt-stdin.");
  return undefined;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function triggerNotice(root: string): string {
  const owner = liveTrigger(workspacePaths(root));
  return owner
    ? `The scheduling Trigger is running (pid ${owner.pid}); scheduled execution requires this foreground process to remain alive.`
    : "The scheduling Trigger is not running. Start `feishu automation serve` explicitly for scheduled firing; saving a job does not start it.";
}

function catchUpPolicy(schedule: Schedule): string {
  if (schedule.kind === "oneshot") return `${schedule.latenessMinutes}m lateness window`;
  return schedule.catchUpMinutes === null ? "catch-up disabled (due minute only)" : `${schedule.catchUpMinutes}m catch-up`;
}

function planLines(input: PlanInput, schedule: Schedule, nextDue: number | null, root: string): string[] {
  const next = nextDue === null ? "none within the planning horizon" : new Date(nextDue).toISOString();
  return [
    `Automation Job plan (${schedule.kind}):`,
    `  name:        ${input.name}`,
    `  task:        ${input.task.trim().split("\n").join("\n               ")}`,
    `  schedule:    ${resolveScheduleLabel(schedule)}`,
    `  timezone:    ${schedule.kind === "interval" ? "n/a (elapsed duration)" : schedule.timeZone}`,
    `  timing:      ${catchUpPolicy(schedule)}; next occurrence ${next}`,
    `  timeout:     ${input.timeoutMinutes} minute${input.timeoutMinutes === 1 ? "" : "s"}`,
    `  lark profile: ${input.profile}`,
    "  identity:    ordinary messages as bot; document appends as user (prompt-level policy)",
    triggerNotice(root),
  ];
}

async function confirmPlan(lines: string[], yes: boolean, question: string, nonInteractive: string): Promise<void> {
  process.stderr.write(`${lines.join("\n")}\n`);
  if (yes) return;
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    fail(nonInteractive);
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await prompt.question(question)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") fail("Declined; no change was made.");
  } finally { prompt.close(); }
}

/** Parse exactly one schedule kind from explicit flags, rejecting conflicts before mutation. */
function buildExplicitSchedule(rest: string[], input: PlanInput, anchorMs: number): Schedule {
  const kinds = [input.at !== undefined, input.cron !== undefined, input.every !== undefined].filter(Boolean).length;
  if (kinds > 1) {
    fail("Provide exactly one schedule: --at <ISO-time> (one-shot), --cron '<five fields>' (recurring), or --every <duration> (fixed interval).");
  }
  if (input.catchUpRaw !== undefined && input.noCatchUp) fail("--catch-up and --no-catch-up are mutually exclusive.");
  if (input.at !== undefined) {
    if (input.noCatchUp) fail("--no-catch-up applies only to recurring schedules (--cron/--every); a one-shot always has a lateness window (use --catch-up to adjust it).");
    const latenessMinutes = input.catchUpRaw === undefined ? DEFAULT_LATENESS_MINUTES : parseDurationMinutes(input.catchUpRaw);
    return { ...parseOneShot(input.at, input.timeZone), latenessMinutes };
  }
  const catchUpMinutes = input.noCatchUp ? null : input.catchUpRaw === undefined ? DEFAULT_LATENESS_MINUTES : parseDurationMinutes(input.catchUpRaw);
  if (input.cron !== undefined) return parseCronSchedule(input.cron, input.timeZone, catchUpMinutes);
  if (input.every !== undefined) {
    const interval = parseInterval(input.every, anchorMs);
    interval.catchUpMinutes = catchUpMinutes;
    return interval;
  }
  throw new AutomationError("Provide exactly one schedule: --at <ISO-time> (one-shot), --cron '<five fields>' (recurring), or --every <duration> (fixed interval).");
}

/**
 * Resolve the catch-up/window policy for an explicit schedule rebuild.
 * Policy is inherited from the old schedule ONLY when neither --catch-up nor
 * --no-catch-up is supplied (a disabled null window stays null); an explicit
 * --at supplies no recurring policy (undefined -> one-shot default).
 */
function resolveUpdatePolicy(
  oldSchedule: Schedule,
  rest: string[],
): { catchUpRaw: string | undefined; noCatchUp: boolean } {
  const noCatchUp = rest.includes("--no-catch-up");
  const catchUpRaw = flagValue(rest, "--catch-up");
  if (noCatchUp && catchUpRaw !== undefined) fail("--catch-up and --no-catch-up are mutually exclusive.");
  if (noCatchUp || catchUpRaw !== undefined) return { catchUpRaw, noCatchUp };
  // Inherit the saved policy when no policy flag is supplied. An explicit
  // --at rebuilds a one-shot and keeps its previous lateness window.
  if (rest.includes("--at") && oldSchedule.kind === "oneshot") {
    return { catchUpRaw: String(oldSchedule.latenessMinutes), noCatchUp: false };
  }
  if (rest.includes("--at")) return { catchUpRaw: undefined, noCatchUp: false };
  if (oldSchedule.kind === "cron" || oldSchedule.kind === "interval") {
    return oldSchedule.catchUpMinutes === null
      ? { catchUpRaw: undefined, noCatchUp: true }
      : { catchUpRaw: String(oldSchedule.catchUpMinutes), noCatchUp: false };
  }
  return { catchUpRaw: String(oldSchedule.latenessMinutes), noCatchUp: false };
}

/**
 * Parse update flags against the saved job and validate the complete
 * resulting plan before any mutation or confirmation. Schedule kind flags
 * are mutually exclusive; --no-catch-up is recurring-only; omitted policies
 * (including a disabled catch-up window, null) are retained.
 *
 * Interval anchors: when kind AND duration are unchanged the existing anchor
 * is always kept (only policy/other fields may differ). A genuinely changed
 * duration or a switch into interval is built with a placeholder anchor that
 * is assigned only AFTER affirmative confirmation, so delayed approval cannot
 * move the beat early.
 */
function buildUpdatedSchedule(
  existing: JobRecord,
  rest: string[],
): { schedule: Schedule; scheduleChanged: boolean; intervalAnchorChanged: boolean } {
  const oldSchedule = existing.schedule;
  const explicitKinds = ["--at", "--cron", "--every"].filter((flag) => rest.includes(flag)).length;
  if (explicitKinds > 1) {
    fail("Provide exactly one schedule: --at <ISO-time> (one-shot), --cron '<five fields>' (recurring), or --every <duration> (fixed interval).");
  }
  const noCatchUp = rest.includes("--no-catch-up");
  const catchUpRaw = flagValue(rest, "--catch-up");
  if (noCatchUp && catchUpRaw !== undefined) fail("--catch-up and --no-catch-up are mutually exclusive.");
  const tz = flagValue(rest, "--tz") ?? (oldSchedule.kind === "interval" ? DEFAULT_TIMEZONE : oldSchedule.timeZone);

  if (!explicitKinds) {
    // Same kind; tz/catch-up may change. A disabled window (null) is retained.
    if (oldSchedule.kind === "oneshot") {
      if (noCatchUp) fail("--no-catch-up applies only to recurring schedules (--cron/--every); a one-shot always keeps a lateness window (use --catch-up to adjust it).");
      const lateness = catchUpRaw === undefined ? oldSchedule.latenessMinutes : parseDurationMinutes(catchUpRaw);
      const rebuilt = { ...parseOneShot(oldSchedule.wall + (oldSchedule.offset ?? ""), tz), latenessMinutes: lateness };
      return { schedule: rebuilt, scheduleChanged: JSON.stringify(rebuilt) !== JSON.stringify(oldSchedule), intervalAnchorChanged: false };
    }
    if (oldSchedule.kind === "cron") {
      const catchUpMinutes = noCatchUp ? null : catchUpRaw !== undefined ? parseDurationMinutes(catchUpRaw) : oldSchedule.catchUpMinutes;
      const rebuilt = parseCronSchedule(oldSchedule.expr, tz, catchUpMinutes);
      return { schedule: rebuilt, scheduleChanged: JSON.stringify(rebuilt) !== JSON.stringify(oldSchedule), intervalAnchorChanged: false };
    }
    const catchUpMinutes = noCatchUp ? null : catchUpRaw !== undefined ? parseDurationMinutes(catchUpRaw) : oldSchedule.catchUpMinutes;
    const rebuilt = parseInterval(`${oldSchedule.intervalMinutes}m`, oldSchedule.anchorMs);
    rebuilt.catchUpMinutes = catchUpMinutes;
    return { schedule: rebuilt, scheduleChanged: JSON.stringify(rebuilt) !== JSON.stringify(oldSchedule), intervalAnchorChanged: false };
  }

  // An explicit kind flag (re)builds that kind; policy is inherited/overridden.
  const policy = resolveUpdatePolicy(oldSchedule, rest);
  const input: PlanInput = {
    name: existing.name,
    at: flagValue(rest, "--at"),
    cron: flagValue(rest, "--cron"),
    every: flagValue(rest, "--every"),
    timeZone: tz,
    timeoutMinutes: 0,
    catchUpRaw: policy.catchUpRaw,
    noCatchUp: policy.noCatchUp,
    task: existing.task,
    profile: existing.profile,
    yes: false,
  };
  // Interval anchors are applied only at approval, so pass a placeholder now.
  const schedule = buildExplicitSchedule(rest, input, 0);
  // Kind AND duration unchanged: always keep the existing anchor regardless
  // of any policy flag that also changed.
  const sameBeat = oldSchedule.kind === "interval" && schedule.kind === "interval"
    && oldSchedule.intervalMinutes === schedule.intervalMinutes;
  if (sameBeat && schedule.kind === "interval") {
    const kept = parseInterval(`${oldSchedule.intervalMinutes}m`, oldSchedule.anchorMs);
    kept.catchUpMinutes = schedule.catchUpMinutes;
    return { schedule: kept, scheduleChanged: JSON.stringify(kept) !== JSON.stringify(oldSchedule), intervalAnchorChanged: false };
  }
  const intervalAnchorChanged = schedule.kind === "interval";
  return { schedule, scheduleChanged: true, intervalAnchorChanged };
}

export async function automationCommand(args: string[]): Promise<number> {
  const verb = args[1];
  const unattended = process.env.FEISHU_UNATTENDED === "1";
  if (unattended && verb !== "list" && verb !== "show") fail(RECURSION_NOTICE);

  const root = managedWorkspaceHome();

  if (verb === "serve") {
    const workspace = ensureWorkspace(root);
    const code = await serveTrigger(workspace, {
      log: (line) => process.stderr.write(`${line}\n`),
    });
    return code;
  }

  if (verb === "list") {
    const { jobs, warnings } = listJobs(root);
    for (const warning of warnings) process.stderr.write(`Warning: ${warning}\n`);
    process.stdout.write(`${JSON.stringify({ jobs: jobs.map((job) => jobSummary(root, job)) }, null, 2)}\n`);
    return 0;
  }

  if (verb === "show") {
    const job = loadJob(root, args[2]);
    process.stdout.write(`${JSON.stringify(jobView(root, job), null, 2)}\n`);
    return 0;
  }

  if (verb === "add") {
    const rest = args.slice(2);
    const name = flagValue(rest, "--name");
    if (!name) fail("automation add requires --name <slug>.");
    validateName(name);
    const timeZone = flagValue(rest, "--tz") ?? DEFAULT_TIMEZONE;
    const timeoutMinutes = flagValue(rest, "--timeout") ? parseDurationMinutes(flagValue(rest, "--timeout")!) : DEFAULT_TIMEOUT_MINUTES;
    if (timeoutMinutes < 1) fail("Execution timeout must be at least one minute.");
    const task = readTaskValue(rest, true)!;
    if (existsSync(join(root, "jobs", name, "job.json"))) {
      fail(`An Automation Job named "${name}" already exists (including retained removed jobs). Choose a different name or purge it first with "feishu automation rm ${name} --purge".`);
    }

    const createdIso = new Date(nowMs()).toISOString();
    const input: PlanInput = {
      name,
      at: flagValue(rest, "--at"),
      cron: flagValue(rest, "--cron"),
      every: flagValue(rest, "--every"),
      timeZone,
      timeoutMinutes,
      catchUpRaw: flagValue(rest, "--catch-up"),
      noCatchUp: rest.includes("--no-catch-up"),
      task: task.replace(/\s+$/, ""),
      profile: "",
      yes: rest.includes("--yes"),
    };
    // Validate the complete schedule and profile before showing the plan.
    const schedule = buildExplicitSchedule(rest, input, Date.parse(createdIso));
    input.profile = resolveLarkProfile(flagValue(rest, "--lark-profile"), process.env);
    const nextDue = nextOccurrence(schedule, nowMs(), { createdAt: createdIso } as JobRecord);

    await confirmPlan(
      planLines(input, schedule, nextDue, root),
      input.yes,
      "Create this Automation Job? [y/N] ",
      "Noninteractive creation requires explicit confirmation: re-run with --yes after reviewing the plan.",
    );

    // Everything validated and confirmed: seed the managed workspace (missing
    // standing instructions only) and atomically persist the new record.
    const workspace = ensureWorkspace(root);
    const job: JobRecord = {
      version: 1,
      name,
      createdAt: createdIso,
      profile: input.profile,
      task: input.task,
      schedule,
      timeoutMinutes,
      state: "enabled",
      runs: [],
    };
    saveJob(workspace.root, job);
    process.stdout.write(`${JSON.stringify(jobSummary(root, job), null, 2)}\n`);
    process.stderr.write(`Saved. ${triggerNotice(root)} Use \`feishu automation run\` for a separate manual attempt.\n`);
    return 0;
  }

  if (verb === "update") {
    return updateCommand(root, args.slice(2));
  }

  if (verb === "pause") {
    const name = args[2];
    const workspace = ensureWorkspace(root);
    // One atomic transition under the shared lock: set paused AND discard
    // every not-started occurrence due up to now, so an admission cannot
    // expire/skip an occurrence in between. A current run keeps running (its
    // "running" ledger entry is never rewritten).
    let updated: JobRecord;
    try {
      updated = withLifecycleLock(workspace, () => {
        const current = loadJob(root, name);
        if (current.state === "removed") fail(`Job "${name}" is removed; only enabled jobs can be paused.`);
        const paused = { ...current, state: "paused" as const };
        saveJob(root, paused);
        discardPendingOccurrences(workspace, paused, nowMs());
        return paused;
      });
    } catch (error) {
      if (error instanceof AutomationError) fail(error.message);
      throw error;
    }
    process.stdout.write(`${JSON.stringify(jobSummary(root, updated), null, 2)}\n`);
    process.stderr.write(`Paused "${name}": no new work will be admitted; an in-progress run continues. Resume with \`feishu automation resume ${name}\`.\n`);
    return 0;
  }

  if (verb === "resume") {
    const name = args[2];
    const workspace = ensureWorkspace(root);
    // Discard the intentionally paused period and re-enable in one locked
    // step against a freshly loaded record (an edit may have landed while
    // paused): no Trigger tick can admit between discard and enable.
    let enabled: JobRecord;
    let discarded: Array<{ outcome: string }>;
    try {
      const result = withLifecycleLock(workspace, () => {
        const current = loadJob(root, name);
        if (current.state === "removed") fail(`Job "${name}" is removed and cannot be resumed; add it again if needed.`);
        if (current.state !== "paused") fail(`Job "${name}" is not paused.`);
        const skipped = discardPendingOccurrences(workspace, current, nowMs());
        const updated = { ...current, state: "enabled" as const };
        saveJob(root, updated);
        return { updated, skipped };
      });
      enabled = result.updated;
      discarded = result.skipped;
    } catch (error) {
      if (error instanceof AutomationError) fail(error.message);
      throw error;
    }
    const summary = jobSummary(root, enabled);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    const skipped = discarded.filter((entry) => entry.outcome === "lateness-skipped").length;
    process.stderr.write(`Resumed "${name}": ${skipped} paused-period occurrence${skipped === 1 ? "" : "s"} skipped without replay; next occurrence ${summary.nextDueAt ?? "none within the planning horizon"}. An unchanged interval anchor is retained.\n`);
    return 0;
  }

  if (verb === "cancel") {
    return cancelCommand(root, args[2]);
  }

  if (verb === "rm") {
    return removeCommand(root, args.slice(2));
  }

  if (verb === "run") {
    const name = args[2];
    const job = loadJob(root, name);
    if (job.state === "removed") fail(`Job "${name}" is removed and cannot run. Add it again after purging, or inspect it with "feishu automation show ${name}".`);
    // Never seed the managed workspace from a read/inspection-style command:
    // run needs it (and seeds missing standing instructions), show/list do not.
    const workspace = existsSync(join(root, "AGENTS.md")) || existsSync(join(root, "jobs"))
      ? workspacePaths(root)
      : ensureWorkspace(root);
    // 30-day bounded output retention on the same management entry point; it
    // only removes this job's own old run artifacts (never definitions, active
    // work, ledgers, symlinks, or unrelated files).
    try {
      for (const warning of pruneRetainedArtifacts(root).warnings) {
        process.stderr.write(`Warning: ${warning}\n`);
      }
    } catch (error) {
      if (!(error instanceof AutomationError)) throw error;
      process.stderr.write(`Warning: ${error.message}\n`);
    }
    let timeoutMsOverride: number | undefined;
    if (process.env.FEISHU_AUTOMATION_TIMEOUT_MS) {
      timeoutMsOverride = Number(process.env.FEISHU_AUTOMATION_TIMEOUT_MS);
      if (!Number.isFinite(timeoutMsOverride) || timeoutMsOverride <= 0) fail("Invalid FEISHU_AUTOMATION_TIMEOUT_MS override.");
    }
    let result;
    try {
      result = await runJobManual(job, workspace, { timeoutMsOverride });
    } catch (error) {
      if (error instanceof AutomationError) fail(error.message);
      throw error;
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.outcome === "completed" ? 0 : result.outcome === "timeout" ? 124 : 1;
  }

  return 1;
}

async function updateCommand(root: string, restInput: string[]): Promise<number> {
  const name = restInput[0];
  if (!name || name.startsWith("-")) fail("Usage: feishu automation update <name> [options] [--yes].");
  const rest = restInput.slice(1);
  const existing = loadJob(root, name);
  if (existing.state === "removed") fail(`Job "${name}" is removed; add it again after purging instead of updating it.`);

  const taskFlag = readTaskValue(rest, false);
  const timeoutMinutes = flagValue(rest, "--timeout") !== undefined
    ? parseDurationMinutes(flagValue(rest, "--timeout")!)
    : existing.timeoutMinutes;
  if (timeoutMinutes < 1) fail("Execution timeout must be at least one minute.");
  // The whole resulting plan (same-kind rebuild or new kind) is validated now,
  // before confirmation. A genuine interval change still carries its
  // placeholder anchor until approval.
  const { schedule, scheduleChanged, intervalAnchorChanged } = buildUpdatedSchedule(existing, rest);

  const profileFlag = flagValue(rest, "--lark-profile");
  // Saved profile changes only through the explicit selector; the caller's
  // ambient profile can never silently replace the saved binding.
  const profile = profileFlag !== undefined ? resolveLarkProfile(profileFlag, { ...process.env, LARK_PROFILE: undefined }) : existing.profile;
  const task = taskFlag !== undefined ? taskFlag.replace(/\s+$/, "") : existing.task;

  const changes: string[] = [];
  if (task !== existing.task) changes.push("task content");
  if (scheduleChanged) {
    changes.push(`schedule (${existing.schedule.kind} -> ${schedule.kind}: ${resolveScheduleLabel(schedule)})`);
  }
  if (timeoutMinutes !== existing.timeoutMinutes) changes.push(`timeout (${existing.timeoutMinutes}m -> ${timeoutMinutes}m)`);
  if (profile !== existing.profile) changes.push(`lark profile (${existing.profile} -> ${profile})`);
  if (changes.length === 0) fail("Nothing to update: provide at least one of --prompt-file/--prompt-stdin, --at/--cron/--every, --tz, --catch-up/--no-catch-up, --timeout, or --lark-profile.");

  // The displayed plan projects the new interval anchor at "now" (the real
  // anchor is assigned only after approval), so delayed confirmation can never
  // move the beat early.
  const projection: Schedule = intervalAnchorChanged && schedule.kind === "interval"
    ? { ...schedule, anchorMs: nowMs() }
    : schedule;
  const nextDue = nextOccurrence(projection, nowMs(), { ...existing, schedule: projection });
  const plan: PlanInput = {
    name, task, profile, timeZone: projection.kind === "interval" ? DEFAULT_TIMEZONE : projection.timeZone,
    timeoutMinutes, yes: rest.includes("--yes"),
    at: undefined, cron: undefined, every: undefined,
    catchUpRaw: undefined, noCatchUp: false,
  };
  await confirmPlan(
    [`Update to Automation Job "${name}":`, `Changed: ${changes.join("; ")}${intervalAnchorChanged ? " (the interval gets a new anchor on approval)" : ""}`, "", ...planLines(plan, projection, nextDue, root)],
    rest.includes("--yes"),
    "Apply this update? [y/N] ",
    "Noninteractive execution-affecting updates require explicit confirmation: re-run with --yes after reviewing the change.",
  );
  ensureWorkspace(root);
  // Apply atomically under the shared lifecycle lock. The record is reloaded
  // after confirmation: a concurrent edit to the SAME fields, or a pause/removal
  // meanwhile, rejects the stale approval instead of silently reverting it. A
  // run settling meanwhile only touches run history and is merged.
  let saved: JobRecord;
  try {
    saved = mutateJobRecord(root, name, (current) => {
      // An edit cannot resurrect a job paused/removed while confirmation was open.
      if (current.state !== "enabled") {
        throw new AutomationError(`Job "${name}" was ${current.state} while the update awaited confirmation; no change was applied. Review it and re-confirm if needed.`, "busy");
      }
      const untouched = current.timeoutMinutes === existing.timeoutMinutes
        && current.profile === existing.profile
        && current.task === existing.task
        && JSON.stringify(current.schedule) === JSON.stringify(existing.schedule);
      if (!untouched) {
        throw new AutomationError(`Job "${name}" changed while the update awaited confirmation; review it with "feishu automation show ${name}" and re-confirm the edit.`, "busy");
      }
      // The new anchor is the approval instant, not the pre-confirmation one.
      const finalSchedule: Schedule = intervalAnchorChanged && schedule.kind === "interval"
        ? { ...schedule, anchorMs: nowMs() }
        : schedule;
      return {
        ...current,
        task,
        schedule: finalSchedule,
        timeoutMinutes,
        profile,
      };
    });
  } catch (error) {
    if (error instanceof AutomationError) fail(error.message);
    throw error;
  }
  process.stdout.write(`${JSON.stringify({ ...jobSummary(root, saved), task: saved.task }, null, 2)}\n`);
  process.stderr.write(`Updated "${name}". A currently running attempt (if any) keeps its start-time plan snapshot.\n`);
  return 0;
}

async function cancelCommand(root: string, name: string | undefined): Promise<number> {
  if (!name || name.startsWith("-")) fail("Usage: feishu automation cancel <name>.");
  // loadJob surfaces a missing/corrupt record before the lock; the lock then
  // re-reads a live run and binds the request to its exact run identity.
  loadJob(root, name);
  const workspace = workspacePaths(root);
  const held = activeRun(workspace, name);
  if (!held) {
    fail(`No active run of "${name}" to cancel. Use "feishu automation pause ${name}" to stop future admission; previous outcomes are in "feishu automation show ${name}".`);
  }
  const runId = String(held.runId);
  const supervisorPid = Number(held.supervisorPid ?? held.pid);
  try {
    // Run-bound request: the owner acts only because its own runId matches. No
    // PID is signaled from a persisted record, so a recycled PID is irrelevant.
    publishCancelRequest(workspace, name, runId, supervisorPid);
  } catch (error) {
    if (error instanceof AutomationError) fail(error.message);
    throw error;
  }

  // Bounded wait for the owner to record the outcome; otherwise report the
  // honest unknown instead of claiming a cancellation we cannot observe.
  const waitMs = process.env.FEISHU_AUTOMATION_CANCEL_WAIT_MS ? Number(process.env.FEISHU_AUTOMATION_CANCEL_WAIT_MS) : 10_000;
  const deadline = Date.now() + (Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : 10_000);
  let recorded = loadJob(root, name).runs.find((run) => run.runId === runId);
  while (Date.now() < deadline) {
    if (activeRun(workspace, name) === null) {
      recorded = loadJob(root, name).runs.find((run) => run.runId === runId) ?? recorded;
      break;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
  const lock = activeRun(workspace, name);
  const sameRunStillActive = lock !== null && String(lock.runId) === runId;
  const outcome = sameRunStillActive ? "unknown" : (recorded?.outcome ?? "unknown");
  process.stdout.write(`${JSON.stringify({ name, runId, outcome, stillActive: sameRunStillActive }, null, 2)}\n`);
  if (sameRunStillActive) {
    process.stderr.write(`Cancel requested for "${name}" (run ${runId}); it was still active when this command returned, so the outcome is recorded honestly as unknown rather than assumed.\n`);
    return 1;
  }
  if (outcome === "cancelled") {
    process.stderr.write(`Cancelled the active run of "${name}" (run ${runId}). Earlier Feishu effects are not rolled back and the task is not retried automatically.\n`);
    return 0;
  }
  // The run ended before the request took effect (completed/failed/timeout…):
  // name what actually happened instead of claiming a cancellation.
  process.stderr.write(`The active run of "${name}" (run ${runId}) ended as ${outcome} before it could be cancelled; earlier Feishu effects are not rolled back.\n`);
  return 1;
}

async function removeCommand(root: string, rest: string[]): Promise<number> {
  const name = rest[0];
  if (!name || name.startsWith("-")) fail("Usage: feishu automation rm <name> [--purge] [--yes].");
  const options = rest.slice(1);
  const purge = options.includes("--purge");
  const yes = options.includes("--yes");
  for (const token of options) {
    if (token !== "--purge" && token !== "--yes") fail(`Unknown option for automation rm: ${token}. Supported: --purge, --yes.`);
  }
  loadJob(root, name);
  const workspace = workspacePaths(root);
  const jobDir = join(workspace.jobs, name);
  if (purge) {
    if (activeRun(workspace, name)) {
      fail(`Cannot purge "${name}" while a run is active. Pause it with "feishu automation pause ${name}" or stop the run with "feishu automation cancel ${name}" first.`);
    }
    // Permanent deletion of retained artifacts is the destructive path: show
    // exactly what goes and require fresh affirmative confirmation.
    await confirmPlan(
      [`Permanently purge Automation Job "${name}" and ALL retained artifacts:`, `  ${jobDir}`, "This deletes the task definition, run history, outputs, and diagnostics. The job cannot be inspected or manually run afterward."],
      yes,
      `Purge job "${name}" and its retained artifacts? [y/N] `,
      "Noninteractive purge requires explicit confirmation: re-run with --yes after reviewing what will be deleted.",
    );
    // Recheck under the shared lifecycle lock after confirmation: a run admitted
    // while the user was deciding must keep its artifacts.
    const deleted = withLifecycleLock(workspace, () => {
      if (activeRun(workspace, name)) return false;
      rmSync(jobDir, { recursive: true, force: true });
      return true;
    });
    if (!deleted) {
      fail(`Cannot purge "${name}": a run started while purge awaited confirmation. Pause or cancel it first, then retry.`);
    }
    process.stdout.write(`${JSON.stringify({ name, purged: true }, null, 2)}\n`);
    process.stderr.write(`Purged "${name}". Its name can be used again by a new job.\n`);
    return 0;
  }
  // Ordinary removal disables future execution and keeps all records. Refuse
  // while a run is active, and take the lifecycle lock so an admission cannot
  // slip between the check and the state change.
  let removed: JobRecord;
  try {
    removed = mutateJobRecord(root, name, (current) => {
      if (activeRun(workspace, name)) {
        throw new AutomationError(`Cannot remove "${name}" while a run is active. Pause it with "feishu automation pause ${name}" or stop the run with "feishu automation cancel ${name}" first.`);
      }
      if (current.state === "removed") {
        throw new AutomationError(`Job "${name}" is already removed (retained). Use "feishu automation rm ${name} --purge" to permanently delete it.`);
      }
      return { ...current, state: "removed" };
    });
  } catch (error) {
    if (error instanceof AutomationError) fail(error.message);
    throw error;
  }
  process.stdout.write(`${JSON.stringify(jobSummary(root, removed), null, 2)}\n`);
  process.stderr.write(`Removed "${name}" from active scheduling; its definition and run history are retained. It can no longer run, and its name is not reused silently. Purge permanently with "feishu automation rm ${name} --purge".\n`);
  return 0;
}
function loadScheduleStateFor(root: string, name: string) {
  try {
    return loadScheduleState(workspacePaths(root), name);
  } catch (error) {
    if (error instanceof AutomationError) {
      process.stderr.write(`Warning: ${error.message}\n`);
      return undefined;
    }
    throw error;
  }
}

/** The ledger entry for the schedule's CURRENT occurrence, if recorded. */
function currentOccurrence(state: ReturnType<typeof loadScheduleStateFor>, job: JobRecord): OccurrenceState | null | undefined {
  if (!state) return null;
  if (job.schedule.kind === "oneshot") {
    const id = `oneshot:${job.schedule.dueMs}`;
    return state.occurrences.find((entry) => entry.id === id) ?? null;
  }
  if (state.occurrences.length === 0) return null;
  return state.occurrences.reduce((latest, entry) => entry.dueMs > latest.dueMs ? entry : latest);
}

/** Latest ledger entry, if any. */
function latestOccurrence(state: ReturnType<typeof loadScheduleStateFor>): OccurrenceState | null {
  if (!state || state.occurrences.length === 0) return null;
  return state.occurrences.reduce((latest, entry) => entry.dueMs > latest.dueMs ? entry : latest);
}

function scheduledStateFor(job: JobRecord, occurrence: OccurrenceState | null | undefined, now: number): string {
  if (job.state === "removed") return "removed";
  if (job.state === "paused") return "paused";
  if (occurrence === undefined) return "unknown";
  if (occurrence?.status === "running") return "running";
  const outcome = occurrence?.outcome;
  if (job.schedule.kind === "oneshot") {
    // Only the CURRENT occurrence's outcome is terminal here. A historical
    // entry from before an approved --at edit must not mask the new future
    // occurrence as "consumed".
    if (outcome === "expired") return "expired";
    if (outcome === "overlap-skipped") return "overlap-skipped";
    if (outcome) return "consumed";
    const dueMinute = Math.floor(job.schedule.dueMs / 60_000) * 60_000;
    if (now < dueMinute) return "future";
    return now <= occurrenceDeadline(job.schedule, job.schedule.dueMs) ? "due" : "expired";
  }
  // Recurring: an in-window occurrence the Trigger has not processed yet is
  // "due"; otherwise report the genuinely forthcoming minute. A settled
  // current minute never transiently reads as "expired".
  const floor = occurrence?.dueMs ?? createdFloorMs(job);
  const pending = latestDueOccurrence(job.schedule, now, floor, job);
  if (pending && now >= pending.dueMs) return "due";
  const next = nextOccurrenceAfterFloor(job.schedule, now, Math.max(floor, createdFloorMs(job)), job);
  return next === null ? "active" : "future";
}

function scheduleSummary(schedule: Schedule) {
  if (schedule.kind === "oneshot") {
    return {
      kind: "oneshot" as const,
      resolvedLocal: resolveOneShotLabel(schedule),
      timeZone: schedule.timeZone,
      offset: schedule.offset,
      latenessMinutes: schedule.latenessMinutes,
    };
  }
  if (schedule.kind === "cron") {
    return {
      kind: "cron" as const,
      expr: schedule.expr,
      resolvedLocal: resolveScheduleLabel(schedule),
      timeZone: schedule.timeZone,
      catchUpMinutes: schedule.catchUpMinutes,
    };
  }
  return {
    kind: "interval" as const,
    resolvedLocal: resolveScheduleLabel(schedule),
    intervalMinutes: schedule.intervalMinutes,
    anchoredAt: new Date(schedule.anchorMs).toISOString(),
    catchUpMinutes: schedule.catchUpMinutes,
  };
}

function resolveOneShotLabel(schedule: OneShotSchedule): string {
  // Local wrapper kept out of automation.ts to preserve its one-shot-only API.
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: schedule.timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  if (schedule.offset) {
    return `${dtf.format(new Date(schedule.dueMs)).replace(", ", " ")} ${schedule.timeZone} (absolute ${schedule.offset})`;
  }
  return `${schedule.wall.replace("T", " ")} ${schedule.timeZone}`;
}

function jobSummary(root: string, job: JobRecord) {
  const latest = job.runs.at(-1) ?? null;
  const trigger = liveTrigger(workspacePaths(root));
  // undefined = ledger unreadable/corrupt (fail closed); null = no entry yet.
  const state = loadScheduleStateFor(root, job.name);
  const occurrence: OccurrenceState | null | undefined = state === undefined ? undefined : currentOccurrence(state, job);
  const now = nowMs();
  const scheduledState = scheduledStateFor(job, occurrence, now);
  // The floor for "next due" is the newest RECORDED occurrence (history may
  // include pre-edit entries), never a historical one-shot entry alone.
  const floor = state ? recordedFloor(state) : createdFloorMs(job);
  const nextDueMs = state === undefined ? null
    : nextOccurrenceAfterFloor(job.schedule, now, Math.max(floor, createdFloorMs(job)), job);
  const showNext = (scheduledState === "future" || scheduledState === "due") && job.state === "enabled";
  return {
    name: job.name,
    state: job.state,
    scheduledState,
    nextDueAt: showNext && nextDueMs !== null ? new Date(nextDueMs).toISOString() : null,
    profile: job.profile,
    schedule: scheduleSummary(job.schedule),
    timeoutMinutes: job.timeoutMinutes,
    createdAt: job.createdAt,
    latestRun: latest ? { outcome: latest.outcome, startedAt: latest.startedAt, trigger: latest.trigger } : null,
    triggerRunning: trigger !== null,
    triggerPid: trigger?.pid ?? null,
  };
}

function jobView(root: string, job: JobRecord) {
  const state = loadScheduleStateFor(root, job.name);
  const current: OccurrenceState | null | undefined = state === undefined ? undefined : currentOccurrence(state, job);
  let scheduleNotice: string;
  if (job.state === "removed") {
    scheduleNotice = "This job is removed: it cannot run and its name will not be reused silently. Its retained record is shown for audit; purge removes it permanently.";
  } else if (state === undefined) {
    scheduleNotice = "Schedule state is unavailable; cannot determine eligibility. Evidence is preserved.";
  } else if (job.state === "paused") {
    scheduleNotice = "The job is paused: no new work is admitted. A manual run stays possible and neither resumes nor re-arms the schedule.";
  } else {
    try {
      scheduleNotice = scheduleEligibilityNotice(job.schedule, nowMs(), state);
    } catch (error) {
      if (!(error instanceof AutomationError)) throw error;
      scheduleNotice = "Schedule state is unavailable; cannot determine eligibility. Evidence is preserved.";
    }
  }
  return {
    ...jobSummary(root, job),
    task: job.task,
    latestRun: job.runs.at(-1) ?? null,
    recentRuns: job.runs.slice(-10),
    scheduleOccurrence: current ?? null,
    // Recurring ledgers grow one entry per planned minute; expose the recent
    // tail so tests (and future lifecycle commands) can inspect any outcome
    // without asserting on private storage internals. One-shot ledgers carry
    // their single (or historically retained) entry in the same array.
    scheduleOccurrences: state === undefined ? undefined : (state?.occurrences.slice(-50) ?? []),
    scheduleNotice,
  };
}

// The command layer only reads ledger entries through the storage module; it
// never parses private schedule or queue fields directly. Retention cleanup is
// wired into the same management entry points (serve/run) the Trigger uses.
