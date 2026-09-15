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
  occurrenceId,
  type JobRecord,
  type RunOutcome,
  type RunSummary,
  type Workspace,
  admitRun,
  cancelRequested,
  clearCancelRequest,
  loadJob,
  loadScheduleState,
  mutateJobRecord,
  mutateOccurrence,
  nowMs,
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
  /** Scheduled dispatch only: the planned occurrence and its lateness deadline. */
  due?: { dueMs: number; deadlineMs: number };
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
  const scheduled = kind === "scheduled" ? options.due ?? null : null;
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

  // The admission snapshot is reloaded under the shared lifecycle lock, so a
  // pause/remove/edit racing this dispatch cannot be half-seen. Manual runs
  // of retained paused/completed/expired jobs keep the job argument; the
  // enabled-only gate applies only to scheduled admission.
  const scheduledId = scheduled ? occurrenceId(job.schedule, scheduled.dueMs) : null;
  let snapshot: JobRecord;
  let admission: ReturnType<typeof admitRun>;
  if (scheduled) {
    // admitRun reloads the plan and records the running occurrence atomically
    // under the shared lifecycle lock; nothing (pause/another admission) can
    // expire/skip an occurrence that has already been admitted.
    admission = admitRun(workspace, job, kind, { pid: process.pid, runId, startedAt }, { id: scheduledId!, dueMs: scheduled.dueMs, deadlineMs: scheduled.deadlineMs });
    snapshot = admission.fresh;
  } else {
    admission = admitRun(workspace, job, kind, { pid: process.pid, runId, startedAt });
    snapshot = admission.fresh; // re-checked under the lifecycle lock
  }
  // cancel.json left by a previous run is removed inside admitRun under the
  // lifecycle lock, bound to this new run id.
  job = snapshot; // every later decision and the child prompt use the admission snapshot

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
  let cancelled = false;
  const checkCancel = (): void => {
    if (stopped || cancelled) return;
    if (!cancelRequested(workspace, job.name, runId)) return;
    cancelled = true;
    stop();
  };
  // The cancel CLI publishes a run-bound cancel.json; the supervisor polls it
  // on a short interval. No PID from a persisted record is ever signaled, so a
  // recycled or unrelated process cannot be killed.
  const cancelWatcher = setInterval(checkCancel, 100);
  cancelWatcher.unref();
  child.once("message", (message: unknown) => {
    if (!message || typeof message !== "object" || !("type" in message) || message.type !== "automation-ready") return;
    if (stopped) {
      if (child.connected) child.disconnect();
      return;
    }
    try {
      if (scheduled) {
        // The occurrence and snapshot were validated atomically under the
        // lifecycle lock during admitRun. A later approved edit must NOT abort
        // this already-admitted run (it keeps the start-time plan snapshot);
        // only the controlled-clock deadline still guards this checkpoint.
        const now = nowMs();
        if (now < scheduled.dueMs || now > scheduled.deadlineMs) {
          throw new AutomationError("Scheduled time changed before Print admission; outcome remains unknown, without replay.");
        }
        mutateOccurrence(workspace, job.name, scheduledId!, (entry) => ({ ...entry!, childPid: child.pid }));
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
    clearInterval(cancelWatcher);
    clearCancelRequest(workspace, job.name);
    const outcome: RunOutcome = cancelled ? "cancelled" : timedOut ? "timeout" : admissionFailed || exitSignal !== null ? "unknown" : exitCode === 0 ? "completed" : "failed";
    return { outcome, exitCode };
  })();

  return {
    kind, name: job.name, occurrenceId: scheduledId, runId, startedAt, childPid: child.pid!, stop, done,
    release: admission.releaseJobLock,
  };
}

/** Persist the terminal outcome of a scheduled occurrence (durable, no replay). */
export function settleScheduledOccurrence(
  workspace: Workspace,
  name: string,
  occurrenceId: string,
  outcome: RunOutcome | "expired" | "overlap-skipped" | "lateness-skipped",
  runId: string | null,
  exitCode: number | null,
  dueMs?: number,
): void {
  mutateOccurrence(workspace, name, occurrenceId, (entry) => ({
    id: occurrenceId,
    dueMs: entry?.dueMs ?? dueMs ?? Number(occurrenceId.split(":").at(-1)),
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
  // Persist the durable result under the lifecycle lock while the run lock is
  // held, so a concurrent lifecycle edit cannot overwrite a finished run.
  mutateJobRecord(workspace.root, name, (current) => {
    const updated = current;
    const index = updated.runs.findIndex((run) => run.runId === summary.runId);
    if (index < 0) updated.runs.push(summary);
    else updated.runs[index] = summary;
    // ponytail: bounded summary retention per job; 30-day artifact retention is enforced separately.
    updated.runs = updated.runs.slice(-50);
    return updated;
  });
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
  if (job.state === "removed") {
    throw new AutomationError(`Job "${job.name}" is removed and cannot run. Purge its retained record with "feishu automation rm ${job.name} --purge" and add it again if needed.`);
  }
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
    scheduleNotice = scheduleEligibilityNotice(job.schedule, nowMs(), loadScheduleState(workspace, job.name), job.state);
  } catch (error) {
    if (!(error instanceof AutomationError)) throw error;
    process.stderr.write(`Warning: ${error.message}\n`);
    scheduleNotice = "Schedule state is unavailable; cannot determine eligibility. This separate manual attempt finished as recorded; schedule evidence is preserved.";
  }
  return { runId: admitted.runId, outcome, exitCode, note: DELIVERY_NOTE, scheduleNotice };
}
