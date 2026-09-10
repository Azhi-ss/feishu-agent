// feishu automation command handlers (slice 1, issue #39).
// Structured results go to stdout as one JSON object; English diagnostics and
// interactive confirmation go to stderr. All file writes happen only after
// complete validation and affirmative confirmation.

import { existsSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  AutomationError,
  DEFAULT_TIMEZONE,
  DEFAULT_TIMEOUT_MINUTES,
  ensureWorkspace,
  listJobs,
  loadJob,
  managedWorkspaceHome,
  parseDurationMinutes,
  parseOneShot,
  resolveLarkProfile,
  resolvedLocal,
  saveJob,
  scheduleEligibilityNotice,
  validateName,
  type JobRecord,
  type OneShotSchedule,
} from "./automation.js";
import { runJobManual } from "./automation-runner.js";

const RECURSION_NOTICE = "Automation management is disabled inside an inherited unattended run (loop prevention). Run this command from an ordinary Feishu session.";

interface AddOptions {
  name: string;
  at: string;
  timeZone: string;
  timeoutMinutes: number;
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

function planLines(options: AddOptions, schedule: OneShotSchedule): string[] {
  return [
    "Automation Job plan (one-shot):",
    `  name:        ${options.name}`,
    `  task:        ${options.task.trim().split("\n").join("\n               ")}`,
    `  time:        ${resolvedLocal(schedule)} (lateness window ${schedule.latenessMinutes}m)`,
    `  timeout:     ${options.timeoutMinutes} minute${options.timeoutMinutes === 1 ? "" : "s"}`,
    `  lark profile: ${options.profile}`,
    "  identity:    ordinary messages as bot; document appends as user (prompt-level policy)",
    "The scheduling Trigger is not running: the job is stored and enabled, but it will not fire until the Trigger is started in a later release.",
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

  if (verb === "list") {
    const { jobs, warnings } = listJobs(root);
    for (const warning of warnings) process.stderr.write(`Warning: ${warning}\n`);
    process.stdout.write(`${JSON.stringify({ jobs: jobs.map(jobSummary) }, null, 2)}\n`);
    return 0;
  }

  if (verb === "show") {
    const job = loadJob(root, args[2]);
    process.stdout.write(`${JSON.stringify(jobView(job), null, 2)}\n`);
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
    const task = readTask(rest);

    if (existsSync(join(root, "jobs", name, "job.json"))) fail(`An Automation Job named "${name}" already exists; choose a different name.`);

    const schedule = parseOneShot(at, timeZone);
    const profile = resolveLarkProfile(process.env.LARK_PROFILE);

    const options: AddOptions = { name, at, timeZone, timeoutMinutes, task: task.replace(/\s+$/, ""), profile, yes: rest.includes("--yes") };
    await confirm(planLines(options, schedule), options.yes);

    // Everything validated and confirmed: seed the managed workspace (missing
    // standing instructions only) and atomically persist the new record.
    const workspace = ensureWorkspace(root);
    const job: JobRecord = {
      version: 1,
      name,
      createdAt: new Date().toISOString(),
      profile,
      task: options.task,
      schedule: { ...schedule },
      timeoutMinutes,
      state: "enabled",
      runs: [],
    };
    saveJob(workspace.root, job);
    process.stdout.write(`${JSON.stringify(jobSummary(job), null, 2)}\n`);
    process.stderr.write("Saved. The scheduling Trigger is not running in this release; use `feishu automation run` to execute manually.\n");
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

function jobSummary(job: JobRecord) {
  const latest = job.runs.at(-1) ?? null;
  const now = Date.now();
  const scheduledState = now < job.schedule.dueMs ? "future"
    : now <= job.schedule.dueMs + job.schedule.latenessMinutes * 60000 ? "due"
    : "expired";
  return {
    name: job.name,
    state: job.state,
    scheduledState,
    profile: job.profile,
    schedule: { kind: job.schedule.kind, resolvedLocal: resolvedLocal(job.schedule), timeZone: job.schedule.timeZone, offset: job.schedule.offset, latenessMinutes: job.schedule.latenessMinutes },
    timeoutMinutes: job.timeoutMinutes,
    createdAt: job.createdAt,
    latestRun: latest ? { outcome: latest.outcome, startedAt: latest.startedAt } : null,
    triggerRunning: false,
  };
}

function jobView(job: JobRecord) {
  return {
    ...jobSummary(job),
    task: job.task,
    latestRun: job.runs.at(-1) ?? null,
    recentRuns: job.runs.slice(-10),
    scheduleNotice: scheduleEligibilityNotice(job.schedule, Date.now()),
  };
}
