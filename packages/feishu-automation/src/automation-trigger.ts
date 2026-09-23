// Foreground Trigger (#40 one-shots, #41 cron and fixed intervals): timing
// only, no retained model session. All children use the same admission and
// Print supervision as manual runs.
import { join } from "node:path";
import {
  AutomationError,
  acquireWorkspaceLock,
  createdFloorMs,
  discardPendingOccurrences,
  dueOccurrencesBetween,
  jobLockPath,
  latestDueOccurrence,
  listJobs,
  loadJob,
  loadScheduleState,
  nextOccurrence,
  nowMs,
  occurrenceDeadline,
  occurrenceId,
  pruneRetainedArtifacts,
  processAlive,
  readLiveLock,
  recordedFloor,
  releaseWorkspaceLock,
  settleOccurrencesBulk,
  tickIntervalMs,
  withLifecycleLock,
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

  const launch = (job: JobRecord, id: string, dueMs: number, deadlineMs: number): void => {
    let run: AdmittedRun;
    try {
      run = startAdmittedRun(job, workspace, "scheduled", { due: { dueMs, deadlineMs } });
    } catch (error) {
      if (!(error instanceof AutomationError)) throw error;
      if (error.reason === "overlap") {
        settleScheduledOccurrence(workspace, job.name, id, "overlap-skipped", null, null, dueMs);
        log(`Job "${job.name}" recorded overlap-skipped at ${new Date(dueMs).toISOString()} without queuing.`);
      } else if (error.reason === "expired") {
        const outcome = job.schedule.kind === "oneshot" ? "expired" : "lateness-skipped";
        settleScheduledOccurrence(workspace, job.name, id, outcome, null, null, dueMs);
        log(`Job "${job.name}" recorded ${outcome} at ${new Date(dueMs).toISOString()} without queuing.`);
      } else if (error.reason === "stale") {
        // The job was paused/removed or its plan changed between evaluation and
        // admission. Nothing was started; the next tick evaluates the fresh plan.
        log(`Job "${job.name}" admission was skipped: ${error.message}`);
      } else if (error.reason !== "capacity" && error.reason !== "busy" && error.reason !== "not-due") {
        warn(error.message);
      }
      return;
    }
    const settled = run.done.then(({ outcome, exitCode }) => {
      // An explicit cancellation request wins over a coincident Trigger stop;
      // ordinary stop bounding stays unknown.
      const result = outcome === "cancelled" ? "cancelled" : stopping && outcome !== "timeout" ? "unknown" : outcome;
      settleScheduledOccurrence(workspace, job.name, id, result, run.runId, exitCode, dueMs);
      recordRunSummary(workspace, job.name, {
        runId: run.runId, startedAt: run.startedAt, endedAt: new Date(nowMs()).toISOString(),
        outcome: result, exitCode, trigger: "scheduled",
      });
      run.release();
      log(`Scheduled run of "${job.name}" (${new Date(dueMs).toISOString()}) settled as ${result}.`);
    }).catch(fatal).finally(() => { owned.delete(job.name); });
    owned.set(job.name, { run, settled });
    log(`Scheduled "${job.name}" admitted for ${new Date(dueMs).toISOString()} (run ${run.runId}, child pid ${run.childPid}).`);
  };

  /** Recover every running occurrence whose supervised child is gone. */
  const recoverOrphans = (job: JobRecord, state: NonNullable<ReturnType<typeof loadScheduleState>>): void => {
    for (const occurrence of state.occurrences) {
      if (occurrence.status !== "running" || !occurrence.runId) continue;
      // A live orphan occupies its existing slot. Never signal persisted PIDs;
      // an unsupervised attempt settles unknown only once that child is gone.
      if (occurrence.childPid && processAlive(occurrence.childPid)) continue;
      const live = readLiveLock(jobLockPath(workspace, job.name));
      if (live?.runId === occurrence.runId) continue;
      const previous = job.runs.find((run) => run.runId === occurrence.runId);
      const outcome = previous?.outcome ?? "unknown";
      settleScheduledOccurrence(workspace, job.name, occurrence.id, outcome, occurrence.runId, previous?.exitCode ?? null, occurrence.dueMs);
      log(`Recovered unsupervised scheduled run "${job.name}" (${new Date(occurrence.dueMs).toISOString()}); recorded ${outcome} without replay.`);
    }
  };

  const evaluateJob = (jobArg: JobRecord): void => {
    // Decide AND settle inside one locked transaction against a freshly
    // reloaded record, so an edit landing after evaluation cannot be
    // overwritten by a stale expiry/skip decision. The locked callback
    // returns the action to perform; the launch itself is outside the lock.
    const decision = withLifecycleLock(workspace, () => {
      const job = loadJob(workspace.root, jobArg.name);
      if (job.state === "removed") return { kind: "none" as const };
      const now = nowMs();
      const state = loadScheduleState(workspace, job.name);
      if (state) recoverOrphans(job, state);
      if (job.state === "paused") {
        try {
          const current = loadScheduleState(workspace, job.name);
          const floor = current ? recordedFloor(current) : -Infinity;
          const candidate = latestDueOccurrence(job.schedule, now, floor, job);
          if (candidate && !(current?.occurrences.some((entry) => entry.id === occurrenceId(job.schedule, candidate.dueMs)))) {
            discardPendingOccurrences(workspace, job, now);
          }
        } catch (error) {
          if (!(error instanceof AutomationError)) throw error;
          warn(error.message);
        }
        return { kind: "none" as const };
      }

      // Re-read after recovery: settled or running occurrences are never started.
      const current = loadScheduleState(workspace, job.name);
      const floor = current ? recordedFloor(current) : -Infinity;
      const candidate = latestDueOccurrence(job.schedule, now, floor, job);
      if (!candidate) return { kind: "none" as const };
      const { dueMs, deadlineMs } = candidate;
      const id = occurrenceId(job.schedule, dueMs);
      const existing = current?.occurrences.find((entry) => entry.id === id);
      if (existing) return { kind: "none" as const };

      if (now > deadlineMs) {
        // Latest eligible never-started occurrence aged out under the
        // CURRENT policy. One-shot expires; recurring skips (latest-only).
        if (job.schedule.kind === "oneshot") {
          settleScheduledOccurrence(workspace, job.name, id, "expired", null, null, dueMs);
          return { kind: "log" as const, text: `Job "${job.name}" recorded expired without running.` };
        }
        settleScheduledOccurrence(workspace, job.name, id, "lateness-skipped", null, null, dueMs);
        return { kind: "log" as const, text: `Recurring job "${job.name}" missed ${new Date(dueMs).toISOString()} past its catch-up window; the occurrence is skipped without backlog replay.` };
      }
      // A new due minute while this job's own previous run is still active is
      // an overlap: skip it without queuing or starting a second child.
      if (owned.has(job.name)) {
        settleScheduledOccurrence(workspace, job.name, id, "overlap-skipped", null, null, dueMs);
        return { kind: "log" as const, text: `Job "${job.name}" is still running; ${new Date(dueMs).toISOString()} is overlap-skipped without queuing.` };
      }
      // Coalesce without backlog: durably skip older eligible due occurrences.
      if (job.schedule.kind !== "oneshot") {
        const listFloor = Math.max(floor, createdFloorMs(job));
        const older = dueOccurrencesBetween(job.schedule, listFloor, dueMs - 1)
          .filter((olderDue) => now <= occurrenceDeadline(job.schedule, olderDue))
          .filter((olderDue) => !current?.occurrences.some((entry) => entry.id === occurrenceId(job.schedule, olderDue)));
        if (older.length > 0) {
          settleOccurrencesBulk(workspace, job.name, older.map((olderDue) => ({
            id: occurrenceId(job.schedule, olderDue), dueMs: olderDue, outcome: "lateness-skipped" as const,
          })));
          log(`Recurring job "${job.name}" coalesced ${older.length} older occurrence${older.length === 1 ? "" : "s"}; only the latest runs.`);
        }
      }
      return { kind: "launch" as const, job, id, dueMs, deadlineMs };
    });
    if (decision.kind === "launch") launch(decision.job, decision.id, decision.dueMs, decision.deadlineMs);
    else if (decision.kind === "log") log(decision.text);
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
  // 30-day bounded output/diagnostic retention: once at startup, then daily.
  const reportPruning = (): void => {
    try {
      const { pruned, warnings } = pruneRetainedArtifacts(workspace.root, nowMs());
      for (const warning of warnings) warn(warning);
      if (pruned > 0) log(`Retention cleanup removed ${pruned} retained output/scratch entr${pruned === 1 ? "y" : "ies"} older than the bounded window.`);
    } catch (error) {
      warn(error instanceof Error ? error.message : String(error));
    }
  };
  const pruningTimer = setInterval(reportPruning, 24 * 3600_000);
  pruningTimer.unref();
  try {
    reportPruning();
    log(`Automation Trigger started (pid ${process.pid}); evaluating saved schedules (one-shot, cron, interval).`);
    evaluate();
    await stopped;
    clearInterval(interval);
    log("Automation Trigger is shutting down; no new scheduled work will be admitted.");
    await Promise.all([...owned.values()].map(({ settled }) => settled));
    return failed ? 1 : 0;
  } finally {
    clearInterval(interval);
    clearInterval(pruningTimer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    releaseWorkspaceLock(lockPath);
    log("Automation Trigger stopped.");
  }
}

/** Planned next occurrence for CLI summaries; null when none is forthcoming. */
export function nextDueFor(job: JobRecord, now: number): number | null {
  return nextOccurrence(job.schedule, now, job);
}
