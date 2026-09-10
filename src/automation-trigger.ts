// Foreground one-shot Trigger (#40): timing only, no retained model session.
// All children use the same admission and Print supervision as manual runs.
import { join } from "node:path";
import {
  AutomationError,
  acquireWorkspaceLock,
  jobLockPath,
  listJobs,
  loadScheduleState,
  nowMs,
  oneshotOccurrenceId,
  processAlive,
  readLiveLock,
  releaseWorkspaceLock,
  tickIntervalMs,
  type JobRecord,
  type Workspace,
} from "./automation.js";
import { recordRunSummary, settleScheduledOccurrence, startAdmittedRun, type AdmittedRun } from "./automation-runner.js";

export function liveTrigger(workspace: Workspace): { pid: number; startedAt: string } | null {
  const held = readLiveLock(join(workspace.root, "trigger.lock"));
  return held ? { pid: Number(held.pid), startedAt: String(held.startedAt ?? "") } : null;
}

export async function serve(workspace: Workspace, options: { log: (line: string) => void }): Promise<number> {
  const lockPath = join(workspace.root, "trigger.lock");
  const log = options.log;
  acquireWorkspaceLock(lockPath, { pid: process.pid, startedAt: new Date(nowMs()).toISOString() }, (held) =>
    `An Automation Trigger is already running for this workspace (pid ${String(held.pid)}). A second foreground Trigger was not started.`);

  const owned = new Map<string, { run: AdmittedRun; settled: Promise<void> }>();
  const warnings = new Set<string>();
  let stopping = false;
  let failed = false;
  let resolveStop: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });
  const stop = (): void => {
    stopping = true;
    for (const { run } of owned.values()) run.stop();
    resolveStop();
  };
  const warn = (message: string): void => {
    if (warnings.has(message)) return;
    warnings.add(message);
    log(`Warning: ${message}`);
  };
  const fatal = (): void => {
    failed = true;
    warn("Automation state could not be updated. Admission stopped; inspect preserved state and run output before retrying.");
    stop();
  };

  const launch = (job: JobRecord, id: string): void => {
    let run: AdmittedRun;
    try {
      run = startAdmittedRun(job, workspace, "scheduled");
    } catch (error) {
      if (!(error instanceof AutomationError)) throw error;
      if (error.reason === "overlap" || error.reason === "expired") {
        const outcome = error.reason === "overlap" ? "overlap-skipped" : "expired";
        settleScheduledOccurrence(workspace, job.name, id, outcome, null, null);
        log(`Job "${job.name}" recorded ${outcome} without queuing.`);
      } else if (error.reason !== "capacity" && error.reason !== "busy" && error.reason !== "not-due") {
        warn(error.message);
      }
      return;
    }
    const settled = run.done.then(({ outcome, exitCode }) => {
      const result = stopping && outcome !== "timeout" ? "unknown" : outcome;
      settleScheduledOccurrence(workspace, job.name, id, result, run.runId, exitCode);
      recordRunSummary(workspace, job.name, {
        runId: run.runId, startedAt: run.startedAt, endedAt: new Date(nowMs()).toISOString(),
        outcome: result, exitCode, trigger: "scheduled",
      });
      run.release();
      log(`Scheduled run of "${job.name}" settled as ${result}.`);
    }).catch(fatal).finally(() => { owned.delete(job.name); });
    owned.set(job.name, { run, settled });
    log(`Scheduled one-shot "${job.name}" admitted (run ${run.runId}, child pid ${run.childPid}).`);
  };

  const evaluateJob = (job: JobRecord): void => {
    if (owned.has(job.name)) return;
    const state = loadScheduleState(workspace, job.name);
    const occurrence = state?.occurrences[0];
    if (occurrence) {
      if (occurrence.status !== "running") return;
      // A live orphan occupies its existing slot. Never signal persisted PIDs;
      // an unsupervised attempt settles unknown only once that child is gone.
      if (occurrence.childPid && processAlive(occurrence.childPid)) return;
      const live = readLiveLock(jobLockPath(workspace, job.name));
      if (live?.runId === occurrence.runId) return;
      const previous = job.runs.find((run) => run.runId === occurrence.runId);
      const outcome = previous?.outcome ?? "unknown";
      settleScheduledOccurrence(workspace, job.name, occurrence.id, outcome, occurrence.runId!, previous?.exitCode ?? null);
      log(`Recovered unsupervised scheduled run "${job.name}"; recorded ${outcome} without replay.`);
      return;
    }
    const now = nowMs();
    if (now < job.schedule.dueMs) return;
    const id = oneshotOccurrenceId(job.schedule.dueMs);
    if (now > job.schedule.dueMs + job.schedule.latenessMinutes * 60000) {
      settleScheduledOccurrence(workspace, job.name, id, "expired", null, null);
      log(`Job "${job.name}" recorded expired without running.`);
      return;
    }
    launch(job, id);
  };

  const evaluate = (): void => {
    if (stopping) return;
    try {
      const listing = listJobs(workspace.root);
      for (const message of listing.warnings) warn(message);
      for (const job of listing.jobs) {
        if (stopping) break;
        try {
          evaluateJob(job);
        } catch (error) {
          if (!(error instanceof AutomationError)) throw error;
          warn(error.message);
        }
      }
    } catch {
      // Any unexpected local I/O failure stops admission and bounds owned
      // children. It must not leave a rejected tick running unsupervised.
      fatal();
    }
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const interval = setInterval(evaluate, tickIntervalMs());
  try {
    log(`Automation Trigger started (pid ${process.pid}); evaluating saved one-shot jobs.`);
    evaluate();
    await stopped;
    clearInterval(interval);
    log("Automation Trigger is shutting down; no new scheduled work will be admitted.");
    await Promise.all([...owned.values()].map(({ settled }) => settled));
    return failed ? 1 : 0;
  } finally {
    clearInterval(interval);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    releaseWorkspaceLock(lockPath);
    log("Automation Trigger stopped.");
  }
}
