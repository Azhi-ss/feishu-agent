// One-shot Automation storage, admission, and schedule state (#39/#40).
// The Trigger and manual CLI share these local, versioned records and locks.
// Recurring schedules, lifecycle editing, OS services, and Skills are later slices.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const RECORD_VERSION = 1;
export const STATE_VERSION = 1;
export const DEFAULT_TIMEZONE = "Asia/Shanghai";
export const DEFAULT_TIMEOUT_MINUTES = 10;
export const DEFAULT_LATENESS_MINUTES = 120;
export const MAX_CONCURRENT_RUNS = 2;
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export class AutomationError extends Error {
  constructor(message: string, readonly reason?: "busy" | "overlap" | "capacity" | "not-due" | "expired") {
    super(message);
  }
}

export interface OneShotSchedule {
  kind: "oneshot";
  /** Wall-clock time in the saved zone for offset-less input, e.g. 2030-06-01T09:00. */
  wall: string;
  timeZone: string;
  /** IANA zone name for offset-less input; null when an explicit offset fixed the instant. */
  offset: string | null;
  /** Resolved absolute instant (epoch ms). */
  dueMs: number;
  /** Lateness window: missed first start is admitted until dueMs + this many minutes. */
  latenessMinutes: number;
}

export interface JobRecord {
  version: number;
  name: string;
  createdAt: string;
  profile: string;
  task: string;
  schedule: OneShotSchedule;
  timeoutMinutes: number;
  state: "enabled";
  runs: RunSummary[];
}

export type RunOutcome = "completed" | "failed" | "timeout" | "unknown";

export interface RunSummary {
  runId: string;
  startedAt: string;
  endedAt: string | null;
  outcome: RunOutcome;
  exitCode: number | null;
  trigger: "manual" | "scheduled";
}

// ----------------------------------------------------------------------------
// Controlled clock seam
// ----------------------------------------------------------------------------

/**
 * Current time in epoch ms. Production uses Date.now; hermetic Trigger tests
 * point FEISHU_AUTOMATION_CLOCK_FILE at a frozen {"now": <ms>} fixture they
 * rewrite between ticks. There is deliberately no public clock flag: the only
 * callers of this seam are automation internals.
 */
export function nowMs(env: NodeJS.ProcessEnv = process.env): number {
  const clockFile = env.FEISHU_AUTOMATION_CLOCK_FILE;
  if (!clockFile) return Date.now();
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(clockFile, "utf8")).now;
  } catch {
    throw new AutomationError("Controlled automation clock is unreadable; no timing decision was made.");
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) {
    throw new AutomationError("Controlled automation clock requires a valid epoch-millisecond value.");
  }
  return value;
}

/** The one clock fixture accelerates tick/termination checkpoints, not production time. */
export function tickIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return env.FEISHU_AUTOMATION_CLOCK_FILE ? 40 : 20_000;
}

export function stopGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  return env.FEISHU_AUTOMATION_CLOCK_FILE ? 200 : 10_000;
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

export function parseDurationMinutes(raw: string): number {
  const match = /^(\d+)(m|h|d)?$/.exec(raw.trim());
  if (!match) throw new AutomationError(`Duration must be a positive duration in minutes, hours, or days (for example 30m, 2h, 1d).`);
  const value = Number(match[1]);
  if (value < 1) throw new AutomationError(`Duration must be a positive duration of at least one minute.`);
  const multiplier = match[2] === "h" ? 60 : match[2] === "d" ? 1440 : 1;
  const minutes = value * multiplier;
  if (!Number.isSafeInteger(minutes) || minutes * 60000 > 2147483647) {
    throw new AutomationError(`Duration is too large; use a smaller timeout (at most about 35,791 minutes).`);
  }
  return minutes;
}

// ---------------------------------------------------------------------------
// Time: one-shot parsing with explicit-offset / offset-less-zone semantics
// ---------------------------------------------------------------------------

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?:([zZ])|([+-]\d{2}):?(\d{2}))?$/;

function validCalendarParts(year: number, month: number, day: number, hour: number, minute: number): boolean {
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    throw new AutomationError(`Unknown timezone "${timeZone}". Use an IANA timezone name such as Asia/Shanghai or America/New_York.`);
  }
}

/** UTC offset (minutes) for the given epoch in the given IANA zone. */
function zoneOffsetMinutes(dueMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(dueMs)).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour === "24" ? "0" : parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - dueMs) / 60000);
}

/**
 * Resolve an ISO 8601 one-shot value at minute resolution.
 * - Explicit offset (or Z): an absolute instant, the saved zone is recorded.
 * - Offset-less local time: interpreted in `timeZone`; ambiguous (DST repeat)
 *   or nonexistent (DST gap) wall times are rejected with a request to supply
 *   an explicit offset.
 */
export function parseOneShot(raw: string, timeZone = DEFAULT_TIMEZONE): OneShotSchedule {
  assertTimeZone(timeZone);
  const match = ISO_RE.exec(raw.trim());
  if (!match) {
    throw new AutomationError(`One-shot time must be an ISO 8601 date-time at minute resolution, for example 2030-06-01T09:00 (job timezone) or 2030-06-01T09:00+08:00 (absolute). Relative phrases must be converted to an absolute ISO time by the caller.`);
  }
  const [, y, mo, d, h, mi, z, oh, om] = match;
  const year = Number(y), month = Number(mo), day = Number(d), hour = Number(h), minute = Number(mi);
  if (!validCalendarParts(year, month, day, hour, minute)) {
    throw new AutomationError(`One-shot time "${raw}" is not a valid ISO 8601 date-time.`);
  }
  const wall = `${y}-${mo}-${d}T${h}:${mi}`;

  if (z || oh) {
    const sign = z ? "+" : oh![0];
    const offsetHours = z ? 0 : Number(oh!.slice(1));
    const offsetMinutes = z ? 0 : Number(om);
    if (offsetHours > 23 || offsetMinutes > 59) throw new AutomationError(`One-shot time "${raw}" has an invalid UTC offset.`);
    const offsetTotal = (sign === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes);
    const dueMs = Date.UTC(year, month - 1, day, hour, minute) - offsetTotal * 60000;
    return { kind: "oneshot", wall, timeZone, offset: z ? "Z" : `${sign}${String(offsetHours).padStart(2, "0")}:${String(offsetMinutes).padStart(2, "0")}`, dueMs, latenessMinutes: DEFAULT_LATENESS_MINUTES };
  }

  // Offset-less: find the epoch whose wall time in the zone equals the request.
  // Brackets are noon-anchored candidate plus a one-day sweep; then classify
  // against the zone's offsets at neighboring epochs.
  const targetUtcNoon = Date.UTC(year, month - 1, day, hour - 12, minute);
  let candidates: number[] = [];
  for (let deltaMs = -26 * 3600000; deltaMs <= 26 * 3600000; deltaMs += 3600000) {
    const candidate = targetUtcNoon + deltaMs;
    const off = zoneOffsetMinutes(candidate, timeZone);
    const wallMs = candidate + off * 60000;
    if (new Date(wallMs).toISOString().startsWith(`${y}-${mo}-${d}T${h}:${mi}`)) candidates.push(candidate);
  }
  candidates = [...new Set(candidates)].sort((a, b) => a - b);
  if (candidates.length === 0) {
    throw new AutomationError(`Local time ${wall} does not exist in ${timeZone} (a daylight-saving gap). Specify an explicit offset such as ${wall}-04:00.`);
  }
  if (candidates.length > 1) {
    throw new AutomationError(`Local time ${wall} is ambiguous in ${timeZone} (a daylight-saving repeat). Specify an explicit offset such as ${wall}-04:00.`);
  }
  return { kind: "oneshot", wall, timeZone, offset: null, dueMs: candidates[0], latenessMinutes: DEFAULT_LATENESS_MINUTES };
}

/** Human-readable resolved local time, e.g. "2030-06-01 09:00 Asia/Shanghai". */
export function resolvedLocal(schedule: OneShotSchedule): string {
  if (schedule.offset) {
    const dtf = new Intl.DateTimeFormat("en-CA", { timeZone: schedule.timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const text = dtf.format(new Date(schedule.dueMs)).replace(", ", " ");
    return `${text} ${schedule.timeZone} (absolute ${schedule.offset})`;
  }
  return `${schedule.wall.replace("T", " ")} ${schedule.timeZone}`;
}

/**
 * Eligibility notice for an independently invoked manual run. It never
 * consumes the schedule; the wording reflects the durable occurrence state
 * produced by the Trigger when available (#40).
 */
export function scheduleEligibilityNotice(schedule: OneShotSchedule, nowMsValue: number, state?: ScheduleState | null): string {
  const due = new Date(schedule.dueMs).toISOString();
  const occurrence = state ? findOccurrence(state, oneshotOccurrenceId(schedule.dueMs)) : null;
  if (occurrence?.status === "running") {
    return `The scheduled one-shot occurrence (${due}) has already been consumed; completion is not yet confirmed. This separate manual attempt does not re-arm it and may duplicate external effects.`;
  }
  const outcome = occurrence?.outcome ?? null;
  if (outcome === "expired") {
    return `This manual run is a separate attempt: the scheduled one-shot occurrence (${due}) is expired, and this run neither revives nor re-arms it.`;
  }
  if (outcome) {
    return `This manual run is a separate attempt: the scheduled one-shot occurrence (${due}) already settled as ${outcome}; this run may repeat its external effects and neither consumes nor re-arms the schedule.`;
  }
  if (nowMsValue < schedule.dueMs) {
    return `The scheduled one-shot occurrence (${due}) is still in the future and remains eligible for Trigger dispatch; this manual run neither consumed nor re-armed it.`;
  }
  const windowEnd = schedule.dueMs + schedule.latenessMinutes * 60000;
  if (nowMsValue <= windowEnd) {
    return `The scheduled one-shot occurrence (${due}) is still within its ${schedule.latenessMinutes}-minute lateness window and remains eligible; this manual run neither consumed nor re-armed it.`;
  }
  return `The scheduled one-shot occurrence (${due}) is past its ${schedule.latenessMinutes}-minute lateness window and would be recorded expired by the Trigger; this manual run neither consumed nor re-armed the schedule.`;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export function validateName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new AutomationError(`Job name must be a safe name of 1-32 characters: lowercase letters, digits, and hyphens; it must start and end with a letter or digit (for example daily-reminder).`);
  }
}

// ---------------------------------------------------------------------------
// Workspace layout and atomic JSON records
// ---------------------------------------------------------------------------

export function managedWorkspaceHome(home: string = homedir()): string {
  // ponytail: one fixed dedicated managed workspace, separate from the legacy
  // Briefing workspace at ~/feishu-automation. FEISHU_AUTOMATION_HOME exists
  // for hermetic tests only and must never be set in production entry points.
  return process.env.FEISHU_AUTOMATION_HOME || join(home, "feishu-jobs");
}

export interface Workspace { root: string; jobs: string; standingInstructions: string }

export function workspacePaths(root: string): Workspace {
  return { root, jobs: join(root, "jobs"), standingInstructions: join(root, "AGENTS.md") };
}

function atomicWriteJson(path: string, value: unknown): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx", flush: true });
  renameSync(tmp, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

const lockOwners = new Map<string, string>();

/** Publish a complete owner record atomically; never expose a half-written lock. */
export function acquireWorkspaceLock(
  lockPath: string,
  contents: Record<string, unknown>,
  liveError: (held: Record<string, unknown>) => string,
): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const candidate = `${lockPath}.${token}.candidate`;
  writeFileSync(candidate, JSON.stringify({ ...contents, version: 1, token }) + "\n", { mode: 0o600, flag: "wx", flush: true });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(candidate, lockPath);
        lockOwners.set(lockPath, token);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const held = readLockRecord(lockPath);
      if (!held) continue;
      if (lockAlive(held)) throw new AutomationError(liveError(held));

      // One reclaimer at a time. A crash during reclaim preserves both files
      // and fails closed with an actionable diagnosis, rather than guessing.
      const recovery = `${lockPath}.recovery`;
      try {
        linkSync(candidate, recovery);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw new AutomationError(`Lock recovery is already in progress or was interrupted at ${recovery}; evidence is preserved. Inspect the owner before explicitly clearing the recovery marker.`);
      }
      try {
        const current = readLockRecord(lockPath);
        if (current && !lockAlive(current)) {
          renameSync(lockPath, `${lockPath}.${randomUUID()}.stale`);
        }
      } finally {
        rmSync(recovery);
      }
    }
    throw new AutomationError("Automation admission changed concurrently; retry the command.");
  } finally {
    rmSync(candidate);
  }
}

export function releaseWorkspaceLock(lockPath: string): void {
  const token = lockOwners.get(lockPath);
  if (!token) return;
  const current = readLockRecord(lockPath);
  if (current?.token === token) rmSync(lockPath);
  lockOwners.delete(lockPath);
}

export function readLockRecord(lockPath: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new AutomationError(`Cannot read lock at ${lockPath}; evidence is preserved.`);
  }
  let held: Record<string, unknown>;
  try {
    held = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new AutomationError(`Corrupt lock at ${lockPath}; evidence is preserved. Inspect it before retrying.`);
  }
  if (!held || typeof held !== "object" || !Number.isSafeInteger(held.pid) || Number(held.pid) <= 0
    || (held.version !== undefined && held.version !== 1)
    || (held.supervisorPid !== undefined && (!Number.isSafeInteger(held.supervisorPid) || Number(held.supervisorPid) <= 0))) {
    throw new AutomationError(`Invalid or unsupported lock at ${lockPath}; evidence is preserved. Inspect it before retrying.`);
  }
  return held;
}

function lockAlive(held: Record<string, unknown>): boolean {
  return processAlive(Number(held.pid))
    || (typeof held.supervisorPid === "number" && processAlive(held.supervisorPid));
}

/** Both a live child and its still-settling supervisor retain the slot. */
export function readLiveLock(lockPath: string): Record<string, unknown> | null {
  const held = readLockRecord(lockPath);
  return held && lockAlive(held) ? held : null;
}

// ----------------------------------------------------------------------------
// Durable scheduled-occurrence state (kept separate from run history)
// ----------------------------------------------------------------------------

export type OccurrenceOutcome =
  | "completed" | "failed" | "timeout" | "unknown"
  | "expired" | "overlap-skipped";

export interface OccurrenceState {
  id: string;
  /** "running" while admitted; "settled" once an outcome is recorded. */
  status: "running" | "settled";
  outcome?: OccurrenceOutcome;
  runId?: string;
  /** Supervised Print PID, persisted before IPC admission. */
  childPid?: number;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
}

export interface ScheduleState {
  version: number;
  name: string;
  occurrences: OccurrenceState[];
}

export function oneshotOccurrenceId(dueMs: number): string {
  return `oneshot:${dueMs}`;
}

export function scheduleStatePath(workspace: Workspace, name: string): string {
  return join(workspace.jobs, name, "schedule.json");
}

export function loadScheduleState(workspace: Workspace, name: string): ScheduleState | null {
  const path = scheduleStatePath(workspace, name);
  if (!existsSync(path)) {
    if (loadJob(workspace.root, name).runs.some((run) => run.trigger === "scheduled")) {
      throw new AutomationError(`Schedule state for "${name}" is missing after a scheduled attempt; run evidence is preserved. Restore the ledger before any scheduling decisions.`);
    }
    return null;
  }
  let state: ScheduleState;
  try {
    state = JSON.parse(readFileSync(path, "utf8")) as ScheduleState;
  } catch {
    throw new AutomationError(`Schedule state for "${name}" is corrupt; it has been preserved for inspection at ${path}.`);
  }
  if (!state || typeof state !== "object") {
    throw new AutomationError(`Schedule state for "${name}" is corrupt; it has been preserved at ${path}.`);
  }
  if (state.version !== STATE_VERSION) {
    throw new AutomationError(`Schedule state for "${name}" uses an unsupported version; it has been preserved at ${path}.`);
  }
  const dueId = oneshotOccurrenceId(loadJob(workspace.root, name).schedule.dueMs);
  if (state.name !== name || !Array.isArray(state.occurrences) || state.occurrences.length !== 1
    || !validOccurrence(state.occurrences[0], dueId)) {
    throw new AutomationError(`Schedule state for "${name}" is corrupt; it has been preserved at ${path}.`);
  }
  return state;
}

function validOccurrence(entry: OccurrenceState | null, dueId: string): boolean {
  if (!entry || typeof entry !== "object" || entry.id !== dueId) return false;
  if (entry.childPid !== undefined && (!Number.isSafeInteger(entry.childPid) || entry.childPid <= 0)) return false;
  if (entry.runId !== undefined && (typeof entry.runId !== "string" || !entry.runId)) return false;
  if (entry.startedAt !== undefined && (typeof entry.startedAt !== "string" || !Number.isFinite(Date.parse(entry.startedAt)))) return false;
  if (entry.exitCode !== undefined && entry.exitCode !== null && !Number.isInteger(entry.exitCode)) return false;
  if (entry.status === "running") return !!entry.runId && !!entry.startedAt && entry.outcome === undefined;
  return entry.status === "settled" && typeof entry.outcome === "string"
    && ["completed", "failed", "timeout", "unknown", "expired", "overlap-skipped"].includes(entry.outcome)
    && typeof entry.endedAt === "string" && Number.isFinite(Date.parse(entry.endedAt));
}

export function saveScheduleState(workspace: Workspace, state: ScheduleState): void {
  atomicWriteJson(scheduleStatePath(workspace, state.name), state);
}

/** The occurrence for one due instant, or null when nothing is recorded. */
export function findOccurrence(state: ScheduleState | null, id: string): OccurrenceState | null {
  return state?.occurrences.find((entry) => entry.id === id) ?? null;
}

export function mutateOccurrence(workspace: Workspace, name: string, id: string, mutate: (entry: OccurrenceState | null) => OccurrenceState | null): OccurrenceState | null {
  const state = loadScheduleState(workspace, name) ?? { version: STATE_VERSION, name, occurrences: [] };
  const index = state.occurrences.findIndex((entry) => entry.id === id);
  const before = index >= 0 ? state.occurrences[index] : null;
  const after = mutate(before ? { ...before } : null);
  if (after) {
    if (index >= 0) state.occurrences[index] = after;
    else state.occurrences.push(after);
    // Never prune occurrence consumption as log cleanup.
    saveScheduleState(workspace, state);
  }
  return after;
}

export const STANDING_INSTRUCTIONS = `# Feishu Automation Workspace

You are executing an approved, self-contained Feishu Automation Job in a fresh unattended run.

## Allowed business actions (prompt-level policy, not an enforced sandbox)

- Send ordinary messages to the fixed conversation named in the job, as the **bot** identity.
- Append-only content to the fixed existing document named in the job, under the **user** identity (never overwrite or delete).

Everything else is out of the approved plan: do not switch identities (no identity fallback), choose new
destinations, create replacement documents, join groups, change memberships or
permissions, process approvals, send urgent notifications, or perform destructive
operations. When required data or access is unavailable, report the failure clearly
in the run output; do not fall back to another identity, destination, or group.

These are behavioral instructions, not a permission boundary: the normal Feishu
tools and Skills remain available, and the existing destructive-command guard is
unchanged. Runner completion is not proof of successful Feishu delivery.

## Workspace hygiene

- Use the per-run scratch directory given in the job prompt for temporary files.
- Do not inspect, create, modify, or schedule other automation jobs, and do not
  start or stop the automation Trigger.
- Do not rely on remembered context: this run has no Long-term Memory; the job
  instructions are the complete task definition.
`;

/** Seed only missing managed standing instructions; never overwrite user edits. */
export function ensureWorkspace(root: string): Workspace {
  const paths = workspacePaths(root);
  mkdirSync(paths.jobs, { recursive: true });
  if (!existsSync(paths.standingInstructions)) {
    writeFileSync(paths.standingInstructions, STANDING_INSTRUCTIONS, { mode: 0o644 });
  }
  return paths;
}

export function listJobs(root: string): { jobs: JobRecord[]; warnings: string[] } {
  const jobsDir = workspacePaths(root).jobs;
  if (!existsSync(jobsDir)) return { jobs: [], warnings: [] };
  const jobs: JobRecord[] = [];
  const warnings: string[] = [];
  for (const name of readdirSync(jobsDir)) {
    const path = join(jobsDir, name, "job.json");
    if (!existsSync(path)) continue;
    try {
      jobs.push(loadJob(root, name));
    } catch (error) {
      // Preserve and surface a bad record without poisoning the whole list.
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { jobs, warnings };
}

export function jobPath(root: string, name: string): string {
  return join(workspacePaths(root).jobs, name, "job.json");
}

export function loadJob(root: string, name: string): JobRecord {
  validateName(name);
  const path = jobPath(root, name);
  if (!existsSync(path)) throw new AutomationError(`No Automation Job named "${name}". Run "feishu automation list" to see saved jobs.`);
  let record: JobRecord;
  try {
    record = JSON.parse(readFileSync(path, "utf8")) as JobRecord;
  } catch {
    throw new AutomationError(`Job record for "${name}" is corrupt; it has been preserved for inspection at ${path}.`);
  }
  if (!record || typeof record !== "object") {
    throw new AutomationError(`Job record for "${name}" is corrupt; it has been preserved at ${path}.`);
  }
  if (record.version !== RECORD_VERSION) {
    throw new AutomationError(`Job record "${name}" uses an unsupported record version; it has been preserved at ${path}.`);
  }
  const schedule = record.schedule;
  if (record.name !== name || record.state !== "enabled"
    || typeof record.profile !== "string" || !record.profile.trim()
    || typeof record.task !== "string" || !record.task.trim()
    || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))
    || !Number.isSafeInteger(record.timeoutMinutes) || record.timeoutMinutes < 1 || record.timeoutMinutes * 60000 > 2147483647
    || !schedule || schedule.kind !== "oneshot"
    || !Number.isSafeInteger(schedule.dueMs) || !Number.isFinite(new Date(schedule.dueMs).getTime())
    || !Number.isSafeInteger(schedule.latenessMinutes) || schedule.latenessMinutes < 1 || schedule.latenessMinutes * 60000 > 2147483647
    || typeof schedule.wall !== "string" || typeof schedule.timeZone !== "string"
    || (schedule.offset !== null && typeof schedule.offset !== "string")
    || !Array.isArray(record.runs) || !record.runs.every(validRunSummary)) {
    throw new AutomationError(`Job record for "${name}" is corrupt; it has been preserved at ${path}.`);
  }
  try {
    const resolved = parseOneShot(schedule.wall + (schedule.offset ?? ""), schedule.timeZone);
    if (resolved.dueMs !== schedule.dueMs) throw new AutomationError("Inconsistent due instant.");
  } catch {
    throw new AutomationError(`Job schedule for "${name}" is invalid; it has been preserved at ${path}.`);
  }
  return record;
}

function validRunSummary(run: RunSummary | null): boolean {
  return !!run && typeof run === "object"
    && typeof run.runId === "string" && !!run.runId
    && typeof run.startedAt === "string" && Number.isFinite(Date.parse(run.startedAt))
    && (run.endedAt === null || (typeof run.endedAt === "string" && Number.isFinite(Date.parse(run.endedAt))))
    && ["completed", "failed", "timeout", "unknown"].includes(run.outcome)
    && ["manual", "scheduled"].includes(run.trigger)
    && (run.exitCode === null || Number.isInteger(run.exitCode));
}

export function saveJob(root: string, job: JobRecord): void {
  const dir = join(workspacePaths(root).jobs, job.name);
  mkdirSync(dir, { recursive: true });
  atomicWriteJson(jobPath(root, job.name), job);
}

// ----------------------------------------------------------------------------
// Shared admission: per-job exclusivity plus the two-different-job capacity.
// Manual callers and the Trigger route through the same file locks, so an
// active manual run occupies shared capacity across Trigger shutdown/restart.
// ----------------------------------------------------------------------------

const JOB_LOCK_NAME = "run.lock";

export function jobLockPath(workspace: Workspace, name: string): string {
  return join(workspace.jobs, name, JOB_LOCK_NAME);
}

function liveJobLocks(workspace: Workspace, except?: string): Array<{ name: string; pid: number }> {
  if (!existsSync(workspace.jobs)) return [];
  const live: Array<{ name: string; pid: number }> = [];
  for (const name of readdirSync(workspace.jobs)) {
    if (except && name === except) continue;
    const held = readLiveLock(join(workspace.jobs, name, JOB_LOCK_NAME));
    if (held && typeof held.pid === "number") live.push({ name, pid: held.pid });
  }
  return live;
}

export interface Admission {
  jobLockPath: string;
  /** Replace the lock payload (supervisor PID -> supervised child PID). */
  replaceContents: (contents: Record<string, unknown>) => void;
  releaseJobLock: () => void;
}

/**
 * Take the workspace admission mutex, then the per-job O_EXCL lock. Scheduled
 * callers receive an overlap-skip error instead of an already-running one;
 * manual callers get the already-running error. Capacity saturation fails
 * honestly rather than queuing; the Trigger treats that as "wait and recheck
 * the deadline". The admission mutex is released before this function
 * returns; the per-job lock stays owned until releaseJobLock().
 */
export function admitRun(
  workspace: Workspace,
  job: JobRecord,
  kind: "manual" | "scheduled",
  lockContents: { pid: number; runId: string; startedAt: string },
): Admission {
  const admissionLockPath = join(workspace.root, "admission.lock");
  try {
    acquireWorkspaceLock(admissionLockPath, { pid: process.pid, runId: lockContents.runId, kind }, () =>
      "Another Automation admission is in progress; retry in a moment.");
  } catch (error) {
    if (error instanceof AutomationError && error.message.startsWith("Another Automation admission")) {
      throw new AutomationError(error.message, "busy");
    }
    throw error;
  }
  try {
    const targetLock = jobLockPath(workspace, job.name);
    const target = readLiveLock(targetLock);
    if (target) {
      const message = `An Automation Run of job "${job.name}" is already running (run ${String(target.runId)}, pid ${String(target.pid)}). Wait for it to finish before starting another run.`;
      throw new AutomationError(message, "overlap");
    }

    const others = liveJobLocks(workspace, job.name);
    if (others.length >= MAX_CONCURRENT_RUNS) {
      throw new AutomationError(`Automation workspace capacity is full: ${others.length} runs of different jobs are active (at most ${MAX_CONCURRENT_RUNS}). Wait for a slot; scheduled waiting never extends its lateness deadline.`, "capacity");
    }

    acquireWorkspaceLock(targetLock, { ...lockContents, kind }, (held) =>
      `An Automation Run of job "${job.name}" is already running (run ${String(held.runId)}, pid ${String(held.pid)}). Wait for it to finish before starting another run.`);

    return {
      jobLockPath: targetLock,
      replaceContents: (contents) => {
        const token = lockOwners.get(targetLock);
        if (!token || readLockRecord(targetLock)?.token !== token) {
          throw new AutomationError(`Automation run ownership changed at ${targetLock}; evidence is preserved.`);
        }
        atomicWriteJson(targetLock, { ...contents, version: 1, token });
      },
      releaseJobLock: () => releaseWorkspaceLock(targetLock),
    };
  } finally {
    releaseWorkspaceLock(admissionLockPath);
  }
}

// ---------------------------------------------------------------------------
// Lark profile resolution: explicit flag/env, then local lark-cli default.
// Zero network: `lark-cli profile list` reads local configuration only.
// ---------------------------------------------------------------------------

interface LarkProfileEntry { name?: string; appId?: string; active?: boolean; effective?: boolean }

export function resolveLarkProfile(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const selected = explicit ?? env.LARK_PROFILE;
  let entries: LarkProfileEntry[] = [];
  try {
    const raw = execFileSync("lark-cli", ["profile", "list"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] });
    entries = JSON.parse(raw) as LarkProfileEntry[];
  } catch {
    throw new AutomationError(`Could not read local lark-cli profiles. Select a profile explicitly with --lark-profile <name> (no network discovery is performed).`);
  }
  if (!Array.isArray(entries)) {
    throw new AutomationError(`Could not read local lark-cli profiles. Select a profile explicitly with --lark-profile <name>.`);
  }
  if (selected) {
    if (!entries.some((entry) => (entry.name ?? entry.appId) === selected)) {
      throw new AutomationError(`Lark profile "${selected}" is not configured locally. Choose one from "lark-cli profile list" and pass it with --lark-profile <name>.`);
    }
    return selected;
  }
  const effectiveEntry = entries.find((entry) => entry.effective || entry.active);
  // Include lark-cli's unnamed default: persist its app id when the profile
  // itself has no name. A profile with neither identifier cannot be bound.
  const effective = effectiveEntry?.name ?? effectiveEntry?.appId;
  if (!effective) {
    throw new AutomationError(`No default Lark profile is configured locally. Select one explicitly with --lark-profile <name>.`);
  }
  return effective;
}
