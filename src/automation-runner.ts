// Supervised Automation Runs (SPEC §16.5; #39 manual, #40 scheduled).
//
// Every run — manual or Trigger-owned — uses the same admission and execution
// path: shared per-job lock plus two-different-job capacity, a fresh
// FEISHU_UNATTENDED=1 Print child in the managed workspace with its own
// scratch area, a per-job timeout, durable stdout/stderr/outcome, and no
// automatic replay. Manual callers own and supervise their own child; the
// Trigger owns scheduled children and stops only those.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AutomationError,
  type JobRecord,
  type RunOutcome,
  type RunSummary,
  type Workspace,
  admitRun,
  loadJob,
  loadScheduleState,
  mutateOccurrence,
  nowMs,
  oneshotOccurrenceId,
  saveJob,
  scheduleEligibilityNotice,
  stopGraceMs,
  tickIntervalMs,
} from "./automation.js";

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

const DELIVERY_NOTE = "Runner completion is not proof of successful Feishu delivery; inspect the run output.";

function runIdNow(kind: "manual" | "sched", date = new Date()): string {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${kind}-${process.pid}-${randomUUID()}`;
}

function buildPrompt(job: JobRecord, scratchDir: string): string {
  return [
    job.task.trim(),
    "",
    "---",
    `Automation Job: ${job.name}`,
    `Per-run scratch directory (use it for temporary files): ${scratchDir}`,
    "This is a fresh unattended run: no Long-term Memory, no previous conversation.",
    "Follow the Automation Workspace standing instructions for allowed actions, identities, and error handling.",
  ].join("\n");
}

export interface AdmittedRun {
  kind: "manual" | "scheduled";
  name: string;
  occurrenceId: string | null;
  runId: string;
  startedAt: string;
  childPid: number;
  /** Bounded stop of the owned detached process group (TERM, then KILL grace). */
  stop: () => void;
  /** Resolves after the child exits or is bounded-stopped; releases nothing. */
  done: Promise<{ outcome: RunOutcome; exitCode: number | null }>;
  /** Free the per-job lock (call only once the durable result is recorded). */
  release: () => void;
}

export interface StartOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMsOverride?: number;
}

/**
 * Admit one run and spawn its fresh unattended Print child. For a scheduled
 * run the occurrence ledger is marked "running" *before* spawn, so a crash
 * after dispatch can never be replayed; the run lock then records the child
 * PID so a Trigger restart can tell a live child from an unsupervised orphan.
 */
export function startAdmittedRun(
  job: JobRecord,
  workspace: Workspace,
  kind: "manual" | "scheduled",
  options: StartOptions = {},
): AdmittedRun {
  const home = options.home ?? homedir();
  const startedAt = new Date(nowMs()).toISOString();
  const runId = runIdNow(kind === "manual" ? "manual" : "sched", new Date(startedAt));
  const jobDir = join(workspace.jobs, job.name);
  const runsDir = join(jobDir, "runs");
  const scratchDir = join(jobDir, "scratch", runId);
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(scratchDir, { recursive: true });
  const stdoutPath = join(runsDir, `${runId}.stdout.log`);
  const stderrPath = join(runsDir, `${runId}.stderr.log`);

  const admission = admitRun(workspace, job, kind, { pid: process.pid, runId, startedAt });
  const occurrenceId = kind === "scheduled" ? oneshotOccurrenceId(job.schedule.dueMs) : null;
  try {
    if (occurrenceId) {
      const now = nowMs();
      if (now < job.schedule.dueMs) throw new AutomationError("Clock moved before the scheduled instant; not admitted.", "not-due");
      if (now > job.schedule.dueMs + job.schedule.latenessMinutes * 60000) {
        throw new AutomationError("Lateness deadline passed before admission.", "expired");
      }
      mutateOccurrence(workspace, job.name, occurrenceId, (existing) => {
        if (existing) throw new AutomationError("Scheduled occurrence was already consumed; no replay.");
        return { id: occurrenceId, status: "running", runId, startedAt };
      });
    }
  } catch (error) {
    admission.releaseJobLock();
    throw error;
  }

  const childEnv: NodeJS.ProcessEnv = { ...options.env ?? process.env };
  for (const key of SECRET_ENV) delete childEnv[key];
  Object.assign(childEnv, {
    HOME: home,
    FEISHU_UNATTENDED: "1",
    FEISHU_AUTOMATION_ADMISSION: "1",
    LARK_PROFILE: job.profile,
    PI_OFFLINE: "1",
  });

  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;
  let child: ReturnType<typeof spawn>;
  try {
    recordRunSummary(workspace, job.name, {
      runId, startedAt, endedAt: null, outcome: "unknown", exitCode: null, trigger: kind,
    });
    stdoutFd = openSync(stdoutPath, "wx", 0o600);
    stderrFd = openSync(stderrPath, "wx", 0o600);
    child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "cli.js"), "-p", buildPrompt(job, scratchDir)], {
      cwd: workspace.root,
      env: childEnv,
      stdio: ["ignore", stdoutFd, stderrFd, "ipc"],
      detached: true,
    });
  } catch {
    admission.releaseJobLock();
    throw new AutomationError(`Cannot start the Print runner for "${job.name}"; existing occurrence and artifacts are preserved.`);
  } finally {
    if (stdoutFd !== undefined) closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
  }
  let admissionFailed = false;
  let stopped = false;
  child.once("message", (message: unknown) => {
    if (!message || typeof message !== "object" || !("type" in message) || message.type !== "automation-ready") return;
    if (stopped) {
      if (child.connected) child.disconnect();
      return;
    }
    try {
      if (occurrenceId) {
        const now = nowMs();
        if (now < job.schedule.dueMs || now > job.schedule.dueMs + job.schedule.latenessMinutes * 60000) {
          throw new AutomationError("Scheduled time changed before Print admission; outcome remains unknown, without replay.");
        }
        mutateOccurrence(workspace, job.name, occurrenceId, (entry) => ({ ...entry!, childPid: child.pid }));
      }
      admission.replaceContents({ pid: child.pid, runId, startedAt, kind, supervisorPid: process.pid });
    } catch {
      // No admission is sent after a persistence failure. The supervised
      // child exits on disconnect without entering the Print runtime.
      admissionFailed = true;
      process.stderr.write(`Automation: Print admission for "${job.name}" was not released; state could not be confirmed. Inspect the preserved run artifacts.\n`);
      if (child.connected) child.disconnect();
      return;
    }
    child.send({ type: "automation-admit" }, (error) => {
      if (!error) return;
      admissionFailed = true;
      if (child.connected) child.disconnect();
    });
  });

  const timeoutMs = options.timeoutMsOverride ?? job.timeoutMinutes * 60000;
  let timedOut = false;
  let killEscalation: NodeJS.Timeout | undefined;
  // Signal only this retained ChildProcess while its exit has not been observed.
  // Recovery never signals a PID obtained from a persisted record.
  let exited = false;
  child.once("exit", () => { exited = true; });
  const stop = (): void => {
    if (stopped || exited || !child.pid) return;
    stopped = true;
    try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    killEscalation = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    }, stopGraceMs());
    killEscalation.unref();
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  timer.unref();
  // The single fixture clock advances scheduling and run deadlines together.
  // Production timeout remains elapsed/monotonic, unaffected by wall rollback.
  const clockTimer = process.env.FEISHU_AUTOMATION_CLOCK_FILE
    ? setInterval(() => {
      if (!exited && nowMs() >= Date.parse(startedAt) + timeoutMs) {
        timedOut = true;
        stop();
      }
    }, tickIntervalMs())
    : undefined;
  clockTimer?.unref();

  const done = (async (): Promise<{ outcome: RunOutcome; exitCode: number | null }> => {
    let exitSignal: NodeJS.Signals | null = null;
    const exitCode: number | null = await new Promise((resolveExit) => {
      child.once("exit", (code, signal) => { exitSignal = signal; resolveExit(code); });
      child.on("error", () => {
        admissionFailed = true;
        if (!child.pid) resolveExit(null); // spawn failed: no process occupies the slot
        else stop(); // IPC errors are not proof that an existing child has ended
      });
    });
    clearTimeout(timer);
    if (clockTimer) clearInterval(clockTimer);
    if (killEscalation) clearTimeout(killEscalation);
    const outcome: RunOutcome = timedOut ? "timeout" : admissionFailed || exitSignal !== null ? "unknown" : exitCode === 0 ? "completed" : "failed";
    return { outcome, exitCode };
  })();

  return {
    kind, name: job.name, occurrenceId, runId, startedAt, childPid: child.pid!, stop, done,
    release: admission.releaseJobLock,
  };
}

/** Persist the terminal outcome of a scheduled occurrence (durable, no replay). */
export function settleScheduledOccurrence(
  workspace: Workspace,
  name: string,
  occurrenceId: string,
  outcome: RunOutcome | "expired" | "overlap-skipped",
  runId: string | null,
  exitCode: number | null,
): void {
  mutateOccurrence(workspace, name, occurrenceId, (entry) => ({
    id: occurrenceId,
    status: "settled",
    outcome,
    runId: entry?.runId ?? runId ?? undefined,
    childPid: entry?.childPid,
    startedAt: entry?.startedAt,
    endedAt: new Date(nowMs()).toISOString(),
    exitCode: exitCode ?? entry?.exitCode ?? null,
  }));
}

/** Append a run summary while the caller still owns the per-job lock. */
export function recordRunSummary(workspace: Workspace, name: string, summary: RunSummary): void {
  // Persist the durable result while the run lock is held so a crash or
  // concurrent supervisor cannot observe a finished run as never started.
  const updated = loadJob(workspace.root, name);
  const index = updated.runs.findIndex((run) => run.runId === summary.runId);
  if (index < 0) updated.runs.push(summary);
  else updated.runs[index] = summary;
  // ponytail: bounded summary retention per job; 30-day artifact retention is enforced by later slices.
  updated.runs = updated.runs.slice(-50);
  saveJob(workspace.root, updated);
}

// ---------------------------------------------------------------------------
// Manual entry point
// ---------------------------------------------------------------------------

export interface ManualRunResult {
  runId: string;
  outcome: RunOutcome;
  exitCode: number | null;
  note: string;
  scheduleNotice: string;
}

/**
 * Independent manual supervisor: admit through the shared path, supervise until
 * the child ends or this caller is interrupted (recorded unknown), then record
 * and release. Never consumes, re-arms, or expires the one-shot schedule.
 */
export async function runJobManual(
  job: JobRecord,
  workspace: Workspace,
  options: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMsOverride?: number;
  } = {},
): Promise<ManualRunResult> {
  const admitted = startAdmittedRun(job, workspace, "manual", options);

  let interrupted = false;
  const onInterrupt = (): void => { interrupted = true; admitted.stop(); };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  options.signal?.addEventListener("abort", onInterrupt, { once: true });

  let { outcome, exitCode } = await admitted.done;
  if (interrupted) outcome = "unknown";
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onInterrupt);
  options.signal?.removeEventListener("abort", onInterrupt);

  recordRunSummary(workspace, job.name, {
    runId: admitted.runId, startedAt: admitted.startedAt, endedAt: new Date(nowMs()).toISOString(),
    outcome, exitCode, trigger: "manual",
  });
  admitted.release();

  let scheduleNotice: string;
  try {
    scheduleNotice = scheduleEligibilityNotice(job.schedule, nowMs(), loadScheduleState(workspace, job.name));
  } catch (error) {
    if (!(error instanceof AutomationError)) throw error;
    process.stderr.write(`Warning: ${error.message}\n`);
    scheduleNotice = "Schedule state is unavailable; cannot determine eligibility. This separate manual attempt finished as recorded; schedule evidence is preserved.";
  }
  return { runId: admitted.runId, outcome, exitCode, note: DELIVERY_NOTE, scheduleNotice };
}
