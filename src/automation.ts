// Automation job management (SPEC §16.5, issue #38; slice 1 = issue #39).
//
// Slice 1 owns: one-shot job add/list/show, and supervised manual runs that
// spawn a fresh memory-less unattended Print child. Recurring schedules,
// lifecycle edits, the Trigger/service, and the model-facing Skill are later
// slices (#40-#44). All state lives in a dedicated managed workspace and is
// local versioned JSON plus task text; nothing here performs network I/O.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const RECORD_VERSION = 1;
export const DEFAULT_TIMEZONE = "Asia/Shanghai";
export const DEFAULT_TIMEOUT_MINUTES = 10;
const DEFAULT_LATENESS_MINUTES = 120;
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export class AutomationError extends Error {}

export interface OneShotSchedule {
  kind: "oneshot";
  /** Wall-clock time in the saved zone for offset-less input, e.g. 2030-06-01T09:00. */
  wall: string;
  timeZone: string;
  /** IANA zone name for offset-less input; null when an explicit offset fixed the instant. */
  offset: string | null;
  /** Resolved absolute instant (epoch ms). */
  dueMs: number;
  /** Lateness window for the future Trigger (minutes); slice 1 only displays it. */
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
  trigger: "manual";
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
 * Eligibility of a one-shot's scheduled occurrence at `now` (derived, never
 * persisted in slice 1: scheduled dispatch/expiry state arrives with #40).
 */
export function scheduleEligibilityNotice(schedule: OneShotSchedule, nowMs: number): string {
  const due = new Date(schedule.dueMs).toISOString();
  if (nowMs < schedule.dueMs) {
    return `The scheduled one-shot occurrence (${due}) is still in the future and remains eligible for Trigger dispatch; this manual run neither consumed nor re-armed it.`;
  }
  const windowEnd = schedule.dueMs + schedule.latenessMinutes * 60000;
  if (nowMs <= windowEnd) {
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
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
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
  const path = jobPath(root, name);
  if (!existsSync(path)) throw new AutomationError(`No Automation Job named "${name}". Run "feishu automation list" to see saved jobs.`);
  let record: JobRecord;
  try {
    record = JSON.parse(readFileSync(path, "utf8")) as JobRecord;
  } catch {
    throw new AutomationError(`Job record for "${name}" is corrupt; it has been preserved for inspection at ${path}.`);
  }
  if (record.version !== RECORD_VERSION) {
    throw new AutomationError(`Job record "${name}" uses an unsupported record version (${record.version}); it has been preserved at ${path}.`);
  }
  return record;
}

export function saveJob(root: string, job: JobRecord): void {
  const dir = join(workspacePaths(root).jobs, job.name);
  mkdirSync(dir, { recursive: true });
  atomicWriteJson(jobPath(root, job.name), job);
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
