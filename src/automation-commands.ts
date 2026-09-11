// feishu automation command handlers (slice 1 #39, slice 2 #40, recurrence #41).
// Structured results go to stdout as one JSON object; English diagnostics and
// interactive confirmation go to stderr. All file writes happen only after
// complete validation and affirmative confirmation.

import { existsSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  AutomationError,
  DEFAULT_LATENESS_MINUTES,
  DEFAULT_TIMEZONE,
  DEFAULT_TIMEOUT_MINUTES,
  createdFloorMs,
  ensureWorkspace,
  latestDueOccurrence,
  listJobs,
  loadJob,
  loadScheduleState,
  managedWorkspaceHome,
  nextOccurrence,
  nextOccurrenceAfterFloor,
  nowMs,
  occurrenceDeadline,
  parseCronSchedule,
  parseDurationMinutes,
  parseInterval,
  parseOneShot,
  resolveLarkProfile,
  resolveScheduleLabel,
  saveJob,
  scheduleEligibilityNotice,
  workspacePaths,
  validateName,
  type JobRecord,
  type OccurrenceState,
  type OneShotSchedule,
  type Schedule,
} from "./automation.js";
import { runJobManual } from "./automation-runner.js";
import { liveTrigger, serve as serveTrigger } from "./automation-trigger.js";

const RECURSION_NOTICE = "Automation management is disabled inside an inherited unattended run (loop prevention). Run this command from an ordinary Feishu session.";

interface AddInput {
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

function readTask(args: string[]): string {
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
  fail("Provide task instructions with --prompt-file <path> or --prompt-stdin.");
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

function planLines(input: AddInput, schedule: Schedule, nextDue: number | null, root: string): string[] {
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

async function confirm(lines: string[], yes: boolean): Promise<void> {
  process.stderr.write(`${lines.join("\n")}\n`);
  if (yes) return;
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    fail("Noninteractive creation requires explicit confirmation: re-run with --yes after reviewing the plan.");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await prompt.question("Create this Automation Job? [y/N] ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") fail("Declined; no Automation Job was created.");
  } finally { prompt.close(); }
}

/** Parse exactly one schedule kind, rejecting conflicts before mutation. */
function buildSchedule(rest: string[], input: AddInput, createdAtMs: number): Schedule {
  const kinds = [input.at !== undefined, input.cron !== undefined, input.every !== undefined].filter(Boolean).length;
  if (kinds !== 1) {
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
  const interval = parseInterval(input.every!, createdAtMs);
  interval.catchUpMinutes = catchUpMinutes;
  return interval;
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
    const task = readTask(rest);
    if (existsSync(join(root, "jobs", name, "job.json"))) fail(`An Automation Job named "${name}" already exists; choose a different name.`);

    const createdIso = new Date(nowMs()).toISOString();
    const input: AddInput = {
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
    const schedule = buildSchedule(rest, input, Date.parse(createdIso));
    input.profile = resolveLarkProfile(process.env.LARK_PROFILE);
    const nextDue = nextOccurrence(schedule, nowMs(), { createdAt: createdIso } as JobRecord);

    await confirm(planLines(input, schedule, nextDue, root), input.yes);

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

  if (verb === "run") {
    const name = args[2];
    const job = loadJob(root, name);
    const workspace = ensureWorkspace(root);
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

/** Latest ledger entry, if any. */
function latestOccurrence(state: ReturnType<typeof loadScheduleStateFor>): OccurrenceState | null {
  if (!state || state.occurrences.length === 0) return null;
  return state.occurrences.reduce((latest, entry) => entry.dueMs > latest.dueMs ? entry : latest);
}

function scheduledStateFor(job: JobRecord, occurrence: OccurrenceState | null | undefined, now: number): string {
  if (occurrence === undefined) return "unknown";
  if (occurrence?.status === "running") return "running";
  const outcome = occurrence?.outcome;
  if (job.schedule.kind === "oneshot") {
    // A one-shot ledger outcome is terminal and authoritative even if the
    // clock later rolls back before the due instant (no replay, no "future").
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
  const occurrence: OccurrenceState | null | undefined = state === undefined ? undefined : latestOccurrence(state);
  const now = nowMs();
  const scheduledState = scheduledStateFor(job, occurrence, now);
  const floor = occurrence?.dueMs ?? createdFloorMs(job);
  const nextDueMs = state === undefined ? null
    : nextOccurrenceAfterFloor(job.schedule, now, Math.max(floor, createdFloorMs(job)), job);
  const showNext = scheduledState === "future" || scheduledState === "due";
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
  const latest: OccurrenceState | null | undefined = state === undefined ? undefined : latestOccurrence(state);
  let scheduleNotice: string;
  if (state === undefined) {
    scheduleNotice = "Schedule state is unavailable; cannot determine eligibility. Evidence is preserved.";
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
    scheduleOccurrence: latest ?? null,
    // Recurring ledgers grow one entry per planned minute; expose the recent
    // tail so tests (and future lifecycle commands) can inspect any outcome
    // without asserting on private storage internals. One-shot ledgers have
    // exactly one entry, which is also the scheduleOccurrence.
    scheduleOccurrences: state === undefined ? undefined : (state?.occurrences.slice(-50) ?? []),
    scheduleNotice,
  };
}

// The command layer only reads ledger entries through the storage module; it
// never parses private schedule or queue fields directly.
