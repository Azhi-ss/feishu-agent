// Supervised manual Automation Runs (SPEC §16.5, issue #39).
//
// A manual run is an independent supervisor process: it acquires the same
// per-job lock a future Trigger will use, spawns a fresh FEISHU_UNATTENDED=1
// Print child in the managed workspace with its own scratch area, bounds it
// with the job timeout, records stdout/stderr/outcome durably, and never
// replays it. The one-shot schedule is neither consumed nor re-armed.

import { spawn } from "node:child_process";
import { closeSync, createWriteStream, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AutomationError,
  type JobRecord,
  type RunOutcome,
  type RunSummary,
  type Workspace,
  loadJob,
  saveJob,
  scheduleEligibilityNotice,
} from "./automation.js";

interface LockContents { pid: number; runId: string; startedAt: string }

function processAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Acquire the per-job run lock with O_EXCL so two concurrent supervisors
 * cannot both pass the liveness check (check-then-write race). A stale owner
 * (dead PID, or an unreadable lock whose run can no longer be supervised) is
 * replaced after rechecking; a live owner wins.
 */
function acquireLock(lockPath: string, contents: LockContents): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (;;) {
    let handle: number | undefined;
    try {
      handle = openSync(lockPath, "wx", 0o600);
      writeFileSync(handle, JSON.stringify(contents, null, 2) + "\n");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let held: LockContents | undefined;
      try { held = JSON.parse(readFileSync(lockPath, "utf8")) as LockContents; }
      // ponytail: an unreadable lock is treated as stale because its owner
      // cannot be supervised; the run's own stdout/stderr artifacts remain.
      catch { held = undefined; }
      if (held && processAlive(held.pid)) {
        throw new AutomationError(`An Automation Run of this job is already running (run ${held.runId}, pid ${held.pid}). Wait for it to finish before starting another run.`);
      }
      rmSync(lockPath, { force: true });
    } finally {
      if (handle !== undefined) { try { closeSync(handle); } catch { /* close best-effort; the lock file was already written */ } }
    }
  }
}

function runIdNow(date = new Date()): string {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-manual-${process.pid}`;
}

export interface ManualRunResult {
  runId: string;
  outcome: RunOutcome;
  exitCode: number | null;
  note: string;
  scheduleNotice: string;
}

const DELIVERY_NOTE = "Runner completion is not proof of successful Feishu delivery; inspect the run output.";
// SPEC section 16.3: the explicit list of secret/autostart variables that must
// never enter an unattended child. FEISHU_REMOTE keeps the bridge inert even
// though its nonsecret companions are stripped too.
const SECRET_ENV = [
  "MEM0_API_KEY",
  "FEISHU_REMOTE",
  "FEISHU_REMOTE_APP_SECRET",
  "FEISHU_REMOTE_APP_ID",
  "FEISHU_REMOTE_OWNER_OPEN_ID",
  "FEISHU_REMOTE_LOOPBACK_URL",
];

/**
 * Start and supervise one fresh unattended Print child for `job`.
 * Returns once the child has exited, been bounded-stopped on timeout, or the
 * supervisor itself was interrupted (recorded as an honest unknown outcome).
 */
export async function runJobManual(
  job: JobRecord,
  workspace: Workspace,
  options: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMsOverride?: number;
    now?: () => number;
  } = {},
): Promise<ManualRunResult> {
  const home = options.home ?? homedir();
  const now = options.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const runId = runIdNow(new Date(now()));
  const jobDir = join(workspace.jobs, job.name);
  const runsDir = join(jobDir, "runs");
  const scratchDir = join(jobDir, "scratch", runId);
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(scratchDir, { recursive: true });
  const stdoutPath = join(runsDir, `${runId}.stdout.log`);
  const stderrPath = join(runsDir, `${runId}.stderr.log`);
  const lockPath = join(jobDir, "run.lock");

  acquireLock(lockPath, { pid: process.pid, runId, startedAt });

  // The child runs a sibling feishu executable: same install as this CLI.
  const selfCli = process.execPath;
  const cliJs = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  const prompt = [
    job.task.trim(),
    "",
    "---",
    `Automation Job: ${job.name}`,
    `Per-run scratch directory (use it for temporary files): ${scratchDir}`,
    "This is a fresh unattended run: no Long-term Memory, no previous conversation.",
    "Follow the Automation Workspace standing instructions for allowed actions, identities, and error handling.",
  ].join("\n");

  const childEnv: NodeJS.ProcessEnv = { ...options.env ?? process.env };
  for (const key of SECRET_ENV) delete childEnv[key];
  Object.assign(childEnv, {
    HOME: home,
    FEISHU_UNATTENDED: "1",
    LARK_PROFILE: job.profile,
    PI_OFFLINE: "1",
  });

  const child = spawn(selfCli, [cliJs, "-p", prompt], {
    cwd: workspace.root,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group so a bounded stop cannot hit an unrelated recycled PID
  });
  const stdoutFd = openSync(stdoutPath, "w");
  const stderrFd = openSync(stderrPath, "w");
  const stdoutStream = createWriteStream("", { fd: stdoutFd });
  const stderrStream = createWriteStream("", { fd: stderrFd });
  child.stdout.pipe(stdoutStream);
  child.stderr.pipe(stderrStream);

  const timeoutMs = options.timeoutMsOverride ?? job.timeoutMinutes * 60000;
  let timedOut = false;
  let interrupted = false;
  let killEscalation: NodeJS.Timeout | undefined;
  // Bounded stop shared by timeout and interruption: terminate the owned
  // process group, then escalate within that same group after 10s. Signaling a
  // bare recycled PID is impossible because the child is detached.
  const boundedStop = (): void => {
    try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    killEscalation = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    }, 10_000);
    killEscalation.unref();
  };
  const timer = setTimeout(() => { timedOut = true; boundedStop(); }, timeoutMs);
  timer.unref();

  const onInterrupt = (): void => { interrupted = true; boundedStop(); };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  options.signal?.addEventListener("abort", onInterrupt, { once: true });

  const exitCode: number | null = await new Promise((resolveExit) => {
    child.on("close", (code) => resolveExit(code));
  });
  clearTimeout(timer);
  if (killEscalation) clearTimeout(killEscalation);
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onInterrupt);
  await Promise.all([
    new Promise<void>((done) => stdoutStream.end(done)),
    new Promise<void>((done) => stderrStream.end(done)),
  ]);

  const endedAt = new Date().toISOString();
  let outcome: RunOutcome;
  if (timedOut) outcome = "timeout";
  else if (interrupted) outcome = "unknown";
  else outcome = exitCode === 0 ? "completed" : "failed";

  const summary: RunSummary = { runId, startedAt, endedAt, outcome, exitCode, trigger: "manual" };
  // Persist the durable result while still holding the run lock so a crash or
  // concurrent supervisor cannot observe a finished run as never started.
  const updated = loadJob(workspace.root, job.name);
  updated.runs.push(summary);
  // ponytail: bounded summary retention per job; 30-day artifact retention is enforced by later slices.
  updated.runs = updated.runs.slice(-50);
  saveJob(workspace.root, updated);
  try { rmSync(lockPath, { force: true }); } catch { /* best-effort; lock rechecked by PID on the next attempt */ }

  const scheduleNotice = scheduleEligibilityNotice(job.schedule, now());
  return { runId, outcome, exitCode, note: DELIVERY_NOTE, scheduleNotice };
}
