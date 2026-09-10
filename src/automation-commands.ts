// feishu automation command handlers (slice 1 #39, slice 2 #40).
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
  ensureWorkspace,
  findOccurrence,
  listJobs,
  loadJob,
  loadScheduleState,
  managedWorkspaceHome,
  nowMs,
  oneshotOccurrenceId,
  parseDurationMinutes,
  parseOneShot,
  resolveLarkProfile,
  resolvedLocal,
  saveJob,
  scheduleEligibilityNotice,
  workspacePaths,
  validateName,
  type JobRecord,
  type OneShotSchedule,
  type OccurrenceState,
} from "./automation.js";
import { runJobManual } from "./automation-runner.js";
import { liveTrigger, serve as serveTrigger } from "./automation-trigger.js";

const RECURSION_NOTICE = "Automation management is disabled inside an inherited unattended run (loop prevention). Run this command from an ordinary Feishu session.";

interface AddOptions {
  name: string;
  at: string;
  timeZone: string;
  timeoutMinutes: number;
  latenessMinutes: number;
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

function planLines(options: AddOptions, schedule: OneShotSchedule, root: string): string[] {
  return [
    "Automation Job plan (one-shot):",
    `  name:        ${options.name}`,
    `  task:        ${options.task.trim().split("\n").join("\n               ")}`,
    `  time:        ${resolvedLocal(schedule)} (lateness window ${schedule.latenessMinutes}m)`,
    `  timeout:     ${options.timeoutMinutes} minute${options.timeoutMinutes === 1 ? "" : "s"}`,
    `  lark profile: ${options.profile}`,
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
    const at = flagValue(rest, "--at");
    if (!at) fail("Exactly one schedule is required (--at <ISO-time> for a one-shot). Cron and interval schedules arrive in a later release.");
    const timeZone = flagValue(rest, "--tz") ?? DEFAULT_TIMEZONE;
    const timeoutMinutes = flagValue(rest, "--timeout") ? parseDurationMinutes(flagValue(rest, "--timeout")!) : DEFAULT_TIMEOUT_MINUTES;
    if (timeoutMinutes < 1) fail("Execution timeout must be at least one minute.");
    const latenessMinutes = flagValue(rest, "--catch-up") === undefined
      ? DEFAULT_LATENESS_MINUTES : parseDurationMinutes(flagValue(rest, "--catch-up")!);
    const task = readTask(rest);

    if (existsSync(join(root, "jobs", name, "job.json"))) fail(`An Automation Job named "${name}" already exists; choose a different name.`);

    const schedule = { ...parseOneShot(at, timeZone), latenessMinutes };
    const profile = resolveLarkProfile(process.env.LARK_PROFILE);

    const options: AddOptions = { name, at, timeZone, timeoutMinutes, latenessMinutes, task: task.replace(/\s+$/, ""), profile, yes: rest.includes("--yes") };
    await confirm(planLines(options, schedule, root), options.yes);

    // Everything validated and confirmed: seed the managed workspace (missing
    // standing instructions only) and atomically persist the new record.
    const workspace = ensureWorkspace(root);
    const job: JobRecord = {
      version: 1,
      name,
      createdAt: new Date().toISOString(),
      profile,
      task: options.task,
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

function oneshotOccurrence(root: string, job: JobRecord): OccurrenceState | null | undefined {
  const state = loadScheduleStateFor(root, job.name);
  if (state === undefined) return undefined;
  return findOccurrence(state, oneshotOccurrenceId(job.schedule.dueMs));
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

function scheduledStateFor(job: JobRecord, occurrence: OccurrenceState | null | undefined, now: number): string {
  if (occurrence === undefined) return "unknown";
  if (occurrence?.status === "running") return "running";
  switch (occurrence?.outcome) {
    case "completed":
    case "failed":
    case "timeout":
    case "unknown":
      return "consumed";
    case "overlap-skipped":
      return "overlap-skipped";
    case "expired":
      return "expired";
    default: {
      const windowEnd = job.schedule.dueMs + job.schedule.latenessMinutes * 60000;
      return now < job.schedule.dueMs ? "future" : now <= windowEnd ? "due" : "expired";
    }
  }
}

function jobSummary(root: string, job: JobRecord) {
  const latest = job.runs.at(-1) ?? null;
  const trigger = liveTrigger(workspacePaths(root));
  const occurrence = oneshotOccurrence(root, job);
  const scheduledState = scheduledStateFor(job, occurrence, nowMs());
  return {
    name: job.name,
    state: job.state,
    scheduledState,
    nextDueAt: scheduledState === "future" || scheduledState === "due" ? new Date(job.schedule.dueMs).toISOString() : null,
    profile: job.profile,
    schedule: { kind: job.schedule.kind, resolvedLocal: resolvedLocal(job.schedule), timeZone: job.schedule.timeZone, offset: job.schedule.offset, latenessMinutes: job.schedule.latenessMinutes },
    timeoutMinutes: job.timeoutMinutes,
    createdAt: job.createdAt,
    latestRun: latest ? { outcome: latest.outcome, startedAt: latest.startedAt, trigger: latest.trigger } : null,
    triggerRunning: trigger !== null,
    triggerPid: trigger?.pid ?? null,
  };
}

function jobView(root: string, job: JobRecord) {
  const state = loadScheduleStateFor(root, job.name);
  return {
    ...jobSummary(root, job),
    task: job.task,
    latestRun: job.runs.at(-1) ?? null,
    recentRuns: job.runs.slice(-10),
    scheduleOccurrence: oneshotOccurrence(root, job) ?? null,
    scheduleNotice: state === undefined
      ? "Schedule state is unavailable; cannot determine eligibility. Evidence is preserved."
      : scheduleEligibilityNotice(job.schedule, nowMs(), state),
  };
}
