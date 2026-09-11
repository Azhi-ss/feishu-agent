// Automation storage, admission, and schedule state (#39/#40 one-shots,
// #41 cron recurrence and fixed intervals).
// The Trigger and manual CLI share these local, versioned records and locks.
// Lifecycle editing, OS services, and the management Skill are later slices.

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

/** Numeric five-field minute-resolution cron; no seconds, macros, or extensions. */
export interface CronSchedule {
  kind: "cron";
  /** The accepted expression verbatim (five single-space-separated fields). */
  expr: string;
  timeZone: string;
  /** Recurring catch-up window in minutes; null disables catch-up (due minute only). */
  catchUpMinutes: number | null;
}

/** True elapsed-time interval; the anchor is the first-enablement instant. */
export interface IntervalSchedule {
  kind: "interval";
  intervalMinutes: number;
  /** First enablement; the first run is one interval after this instant. */
  anchorMs: number;
  catchUpMinutes: number | null;
}

export type Schedule = OneShotSchedule | CronSchedule | IntervalSchedule;

export interface JobRecord {
  version: number;
  name: string;
  createdAt: string;
  profile: string;
  task: string;
  schedule: Schedule;
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
    throw new AutomationError(`Duration is too large; use a smaller value (at most about 35,791 minutes).`);
  }
  return minutes;
}

/** Catch-up allowance when recurring catch-up is disabled: the due minute only. */
// ponytail: the inclusive due-minute end is dueMs + 60_000 - 1 in occurrenceDeadline.

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

// ---------------------------------------------------------------------------
// Calendar cron: numeric five fields, minute resolution (#41)
// ---------------------------------------------------------------------------

// Bounded documented subset (SPEC §16.5): wildcards, lists, ranges, and steps.
// Seconds, macros (@daily), names (MON/JAN), extensions (% / L / W / # / ?),
// and systemd OnCalendar are rejected rather than approximated.
const CRON_FIELD = /^[0-9*/,.-]+$/;
type CronField = number[]; // ascending distinct allowed values

function parseCronField(raw: string, min: number, max: number, label: string): CronField {
  if (raw === "" || !CRON_FIELD.test(raw)) {
    throw new AutomationError(`Cron ${label} field "${raw}" is invalid. Use numbers, *, lists (a,b), ranges (a-b), and steps (a-b/n) only.`);
  }
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    if (part === "" || part.startsWith("-") || part.endsWith("-") || part.includes("**")) {
      throw new AutomationError(`Cron ${label} field "${raw}" is malformed.`);
    }
    const slash = part.split("/");
    if (slash.length > 2) throw new AutomationError(`Cron ${label} field "${raw}" has too many step separators.`);
    const [rangePart, stepPart] = slash;
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^[0-9]+$/.test(stepPart)) throw new AutomationError(`Cron ${label} step "${stepPart}" must be a positive whole number.`);
      step = Number(stepPart);
      if (step < 1) throw new AutomationError(`Cron ${label} step must be at least 1.`);
    }
    let lo = min, hi = max;
    if (rangePart !== "*") {
      const bounds = rangePart.split("-");
      if (bounds.length > 2) throw new AutomationError(`Cron ${label} range "${rangePart}" is malformed.`);
      if (bounds.length === 2) {
        if (bounds[0] === "" || bounds[1] === "") throw new AutomationError(`Cron ${label} range "${rangePart}" is malformed.`);
        lo = Number(bounds[0]);
        hi = Number(bounds[1]);
      } else {
        lo = hi = Number(bounds[0]);
      }
      if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo < min || hi > max) {
        throw new AutomationError(`Cron ${label} values must be between ${min} and ${max} (field "${raw}").`);
      }
    }
    if (rangePart !== "*" && !rangePart.includes("-") && stepPart !== undefined) {
      // A bare value with a step (5/2) has diverging meanings across cron
      // implementations; require a range or the */n shorthand instead.
      throw new AutomationError(`Cron ${label} step requires a range or *, for example */${step} or ${min}-${max}/${step} (field "${raw}").`);
    }
    if (lo > hi) throw new AutomationError(`Cron ${label} range "${rangePart}" is reversed (field "${raw}").`);
    for (let value = lo; value <= hi; value += step) values.add(value);
  }
  if (values.size === 0) throw new AutomationError(`Cron ${label} field "${raw}" matches nothing.`);
  return [...values].sort((a, b) => a - b);
}

interface CronParts { minute: CronField; hour: CronField; dom: CronField; month: CronField; dow: CronField; domRestricted: boolean; dowRestricted: boolean }

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function parseCronParts(expr: string): CronParts {
  const fields = expr.trim().split(/\s+/);
  const [m, h, domRaw, mo, dowRaw] = fields;
  const minute = parseCronField(m, 0, 59, "minute");
  const hour = parseCronField(h, 0, 23, "hour");
  const dom = parseCronField(domRaw, 1, 31, "day-of-month");
  const month = parseCronField(mo, 1, 12, "month");
  const dow = [...new Set(parseCronField(dowRaw, 0, 7, "day-of-week").map((value) => (value === 7 ? 0 : value)))].sort((a, b) => a - b);
  return { minute, hour, dom, month, dow, domRestricted: domRaw !== "*", dowRestricted: dowRaw !== "*" };
}

function parseCron(exprRaw: string, timeZone: string): CronSchedule {
  assertTimeZone(timeZone);
  const expr = exprRaw.trim();
  if (expr.startsWith("@") || expr.includes("  ")) {
    throw new AutomationError(`Cron macros and extensions are not supported. Use exactly five numeric fields: minute hour day-of-month month day-of-week (for example "0 9 * * 1-5").`);
  }
  const fields = expr.split(/\s+/);
  if (fields.length !== 5) {
    throw new AutomationError(`Cron schedule must have exactly five space-separated fields (minute hour day-of-month month day-of-week); got ${fields.length}. Seconds fields and systemd OnCalendar are not supported.`);
  }
  if (!fields.every((field) => CRON_FIELD.test(field))) {
    throw new AutomationError(`Cron expression "${expr}" contains unsupported syntax. Only numbers, *, lists, ranges, and steps are accepted; macros, names, seconds, and extensions are rejected.`);
  }
  const parts = parseCronParts(expr);
  if (!cronRuleHasOccurrence(parts)) {
    throw new AutomationError(`Cron expression "${expr}" never matches any calendar minute; check the day and month fields.`);
  }
  return { kind: "cron", expr, timeZone, catchUpMinutes: DEFAULT_LATENESS_MINUTES };
}

/** Parse and validate a cron schedule, applying the requested catch-up policy. */
export function parseCronSchedule(expr: string, timeZone: string, catchUpMinutes: number | null): CronSchedule {
  const schedule = parseCron(expr, timeZone);
  schedule.catchUpMinutes = catchUpMinutes;
  return schedule;
}

function cronRuleHasOccurrence(parts: CronParts): boolean {
  // Reject rules that can never fire (for example February 31st) with a
  // bounded day scan; a feasible rule matches within a few years.
  const start = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 100 * 366; i++) {
    const d = new Date(start + i * 86_400_000);
    if (cronDayMatches(parts, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCDay())) return true;
  }
  return false;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Standard cron DOM/DOW OR: when both are restricted, either match suffices. */
function cronDayMatches(parts: CronParts, year: number, month: number, dom: number, dowUtc: number): boolean {
  if (!parts.month.includes(month)) return false;
  if (dom > DAYS_IN_MONTH[month - 1]) return false;
  if (month === 2 && dom === 29 && !isLeapYear(year)) return false;
  const domMatch = parts.dom.includes(dom);
  const dowMatch = parts.dow.includes(dowUtc);
  if (parts.domRestricted && parts.dowRestricted) return domMatch || dowMatch;
  if (parts.domRestricted) return domMatch;
  if (parts.dowRestricted) return dowMatch;
  return true;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Local calendar parts (in the zone) for an epoch. */
function zonedParts(ms: number, timeZone: string): { year: number; month: number; day: number; weekday: number } {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" });
  const p = Object.fromEntries(dtf.formatToParts(new Date(ms)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), weekday: WEEKDAYS[p.weekday]! };
}

interface CronPlan { parts: CronParts; expr: string; timeZone: string }

const cronCache = new Map<string, CronPlan>();

function cronPlan(schedule: CronSchedule): CronPlan {
  const key = `${schedule.expr}\u0000${schedule.timeZone}`;
  const cached = cronCache.get(key);
  if (cached) return cached;
  const plan = { parts: parseCronParts(schedule.expr), expr: schedule.expr, timeZone: schedule.timeZone };
  cronCache.set(key, plan);
  return plan;
}

/**
 * Matching instants in the inclusive UTC-instant range. The walk goes directly
 * through allowed month/day/hour/minute fields, so sparse rules cost only
 * matching days. Gaps emit nothing; folds emit their earlier instant once.
 */
function dayOffsets(plan: CronPlan, year: number, month: number, day: number): number[] {
  // At most three offset probes per matching day, cached across wall minutes.
  const key = Date.UTC(year, month - 1, day);
  const cached = dayOffsetCache.get(key);
  if (cached && cached.zone === plan.timeZone) return cached.offsets;
  const offsets = [...new Set([0, 12, 23].map((anchorHour) => zoneOffsetMinutes(Date.UTC(year, month - 1, day, anchorHour), plan.timeZone)))];
  dayOffsetCache.set(key, { zone: plan.timeZone, offsets });
  if (dayOffsetCache.size > 2048) dayOffsetCache.clear();
  return offsets;
}

const dayOffsetCache = new Map<number, { zone: string; offsets: number[] }>();

function dayEpochs(plan: CronPlan, year: number, month: number, day: number, startLocalMs: number, endLocalMs: number): number[] {
  const dayWallUtc = Date.UTC(year, month - 1, day);
  const offsets = dayOffsets(plan, year, month, day);
  // Normal days have one offset; only fold/gap days have two. The common
  // single-offset path needs no per-minute allocation.
  const epochs: number[] = [];
  if (offsets.length === 1) {
    const offset = offsets[0]!;
    for (const hour of plan.parts.hour) {
      for (const minute of plan.parts.minute) {
        const epoch = dayWallUtc + hour * 3_600_000 + minute * 60_000 - offset * 60_000;
        if (epoch >= startLocalMs && epoch <= endLocalMs) epochs.push(epoch);
      }
    }
    return epochs;
  }
  for (const hour of plan.parts.hour) {
    for (const minute of plan.parts.minute) {
      const reading = dayWallUtc + hour * 3_600_000 + minute * 60_000;
      const candidates = offsets
        .filter((offset) => zoneOffsetMinutes(reading - offset * 60_000, plan.timeZone) === offset)
        .map((offset) => reading - offset * 60_000);
      const unique = [...new Set(candidates)].sort((a, b) => a - b);
      for (const epoch of unique.length > 1 ? [unique[0]!] : unique) { // fold -> earlier once; gap -> none
        if (epoch >= startLocalMs && epoch <= endLocalMs) epochs.push(epoch);
      }
    }
  }
  return epochs;
}

/** Walk matching days forward (direction 1) or backward (-1); up to limit instants. */
function cronEpochsInRange(plan: CronPlan, startLocalMs: number, endLocalMs: number, limit: number): number[] {
  const start = zonedParts(Math.max(startLocalMs, Date.UTC(1970, 0, 1)), plan.timeZone);
  const end = zonedParts(endLocalMs, plan.timeZone);
  const out: number[] = [];
  const forward = limit >= 0;
  // The catch-up window bounds dense-rule work; a hard cap guards pathological inputs.
  const maxResults = limit === Infinity ? 200_000 : Math.abs(limit);

  const years: number[] = [];
  for (let y = start.year; y <= end.year; y++) years.push(y);
  if (!forward) years.reverse();

  for (const year of years) {
    const monthFields = forward ? plan.parts.month : [...plan.parts.month].reverse();
    for (const month of monthFields) {
      if (forward && year === start.year && month < start.month) continue;
      if (!forward && year === end.year && month > end.month) continue;
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const dayList: number[] = [];
      for (let d = 1; d <= daysInMonth; d++) dayList.push(d);
      if (!forward) dayList.reverse();
      for (const day of dayList) {
        if (forward && year === start.year && month === start.month && day < start.day) continue;
        if (!forward && year === end.year && month === end.month && day > end.day) continue;
        const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
        if (!cronDayMatches(plan.parts, year, month, day, weekday)) continue;
        const epochs = dayEpochs(plan, year, month, day, startLocalMs, endLocalMs);
        const ordered = forward ? epochs : epochs.reverse();
        for (const epoch of ordered) {
          out.push(epoch); // both walks visit days in order; no final sort needed
          if (out.length >= maxResults) return out;
        }
      }
    }
  }
  return forward ? out : out;
}

/** Earliest matching minute at or after `ms` (and not before notBeforeMs); null past the bound. */
export function cronFirstAtOrAfter(schedule: CronSchedule, ms: number, notBeforeMs: number, horizonDays = 2 * 366): number | null {
  const plan = cronPlan(schedule);
  const from = Math.max(ms, notBeforeMs);
  return cronEpochsInRange(plan, from, from + horizonDays * 86_400_000 + 26 * 3_600_000, 1)[0] ?? null;
}

/** Latest matching minute at or before `ms` and strictly after `afterMs`; null when none. */
export function cronLastAtOrBefore(schedule: CronSchedule, ms: number, afterMs: number): number | null {
  const plan = cronPlan(schedule);
  // Only fully elapsed minutes are "due": floor, never ceil, so a caller
  // partway through minute N does not admit that minute early.
  const nowMinute = Math.floor(ms / 60_000) * 60_000;
  // Backward walk stops at the first match; the window is bounded by the
  // catch-up policy (at most ~25 days at the maximum allowed duration).
  return cronEpochsInRange(plan, afterMs + 1, nowMinute, -1)[0] ?? null;
}

/**
 * Every due recurring instant strictly after `afterMs` and at or before
 * `upToMs`, ascending. The range is bounded by the job's catch-up window via
 * the caller (Trigger coalescing records at most one run plus skipped markers).
 */
export function dueOccurrencesBetween(schedule: Schedule, afterMs: number, upToMs: number): number[] {
  if (schedule.kind === "oneshot") {
    return schedule.dueMs > afterMs && schedule.dueMs <= upToMs ? [schedule.dueMs] : [];
  }
  if (schedule.kind === "interval") {
    const out: number[] = [];
    const intervalMs = schedule.intervalMinutes * 60_000;
    let index = Math.floor((afterMs - schedule.anchorMs) / intervalMs) + 1;
    if (index < 1) index = 1;
    for (let due = intervalStep(schedule, index); due <= upToMs; due = intervalStep(schedule, ++index)) {
      out.push(due);
      // ponytail: same hard cap as the cron path; the durable floor already
      // consumes anything older, so truncation never replays missed work.
      if (out.length >= 200_000) break;
    }
    return out;
  }
  const nowMinute = Math.floor(upToMs / 60_000) * 60_000;
  return cronEpochsInRange(cronPlan(schedule), afterMs + 1, nowMinute, Infinity);
}

// ---------------------------------------------------------------------------
// Fixed intervals: true elapsed durations anchored at first enablement
// ---------------------------------------------------------------------------

export function parseInterval(raw: string, anchorMs: number): IntervalSchedule {
  const intervalMinutes = parseDurationMinutes(raw); // rejects seconds and values < 1
  if (!Number.isSafeInteger(anchorMs) || !Number.isFinite(new Date(anchorMs).getTime())) {
    throw new AutomationError(`Interval anchor must be a valid instant.`);
  }
  return { kind: "interval", intervalMinutes, anchorMs, catchUpMinutes: DEFAULT_LATENESS_MINUTES };
}

function intervalStep(schedule: IntervalSchedule, index: number): number {
  return schedule.anchorMs + index * schedule.intervalMinutes * 60_000;
}

export function intervalFirstAtOrAfter(schedule: IntervalSchedule, ms: number): number {
  const intervalMs = schedule.intervalMinutes * 60_000;
  const elapsed = ms - schedule.anchorMs;
  if (elapsed < intervalMs) return intervalStep(schedule, 1); // first run is one interval after enablement
  return intervalStep(schedule, Math.max(1, Math.ceil(elapsed / intervalMs)));
}

export function intervalLastAtOrBefore(schedule: IntervalSchedule, ms: number, afterMs: number): number | null {
  const intervalMs = schedule.intervalMinutes * 60_000;
  const upper = Math.floor((ms - schedule.anchorMs) / intervalMs);
  if (upper < 1) return null;
  const lower = Math.floor((afterMs - schedule.anchorMs) / intervalMs) + 1;
  if (lower > upper) return null;
  return intervalStep(schedule, upper);
}

// ---------------------------------------------------------------------------
// Schedule-generic occurrence identity and timing
// ---------------------------------------------------------------------------

export function occurrenceId(schedule: Schedule, dueMs: number): string {
  switch (schedule.kind) {
    case "oneshot": return oneshotOccurrenceId(schedule.dueMs);
    case "cron": return `cron:${dueMs}`;
    case "interval": return `interval:${schedule.intervalMinutes}:${dueMs}`;
  }
}

/** Catch-up window end for a planned occurrence; the cutoff is inclusive. */
export function occurrenceDeadline(schedule: Schedule, dueMs: number): number {
  if (schedule.kind === "oneshot") return dueMs + schedule.latenessMinutes * 60_000;
  // Recurring, catch-up disabled: the planned minute only (inclusive end).
  if (schedule.catchUpMinutes === null) return dueMs + 60_000 - 1;
  return dueMs + schedule.catchUpMinutes * 60_000;
}

function createdAfterMs(job: JobRecord | undefined): number {
  // Occurrences before the job existed can never be eligible. The floor is
  // exclusive for cron/interval scans, so it sits one instant below the
  // creation minute to keep a due occurrence in that first minute eligible.
  const created = job ? Date.parse(job.createdAt) : NaN;
  return Number.isFinite(created) ? Math.floor(created / 60_000) * 60_000 - 1 : -Infinity;
}

/** Trigger coalescing floor: the creation minute itself (inclusive). */
export function createdFloorMs(job: JobRecord): number {
  const created = Date.parse(job.createdAt);
  return Number.isFinite(created) ? Math.floor(created / 60_000) * 60_000 : -Infinity;
}

/** Earliest planned occurrence at or after `now`; null past the planning horizon. */
export function nextOccurrence(schedule: Schedule, now: number, job?: JobRecord): number | null {
  const floor = createdAfterMs(job);
  switch (schedule.kind) {
    case "oneshot": return schedule.dueMs >= Math.floor(now / 60_000) * 60_000 ? schedule.dueMs : null;
    case "cron": return cronFirstAtOrAfter(schedule, now, floor);
    case "interval": return intervalFirstAtOrAfter(schedule, Math.max(now, floor));
  }
}

/**
 * Next planned occurrence strictly newer than the recorded floor, for status
 * summaries: an already-handled current minute is never re-reported as "due".
 */
export function nextOccurrenceAfterFloor(schedule: Schedule, now: number, floor: number, job?: JobRecord): number | null {
  if (schedule.kind === "oneshot") {
    return schedule.dueMs > floor && schedule.dueMs >= Math.floor(now / 60_000) * 60_000 ? schedule.dueMs : null;
  }
  const start = Math.max(now, floor + 1, createdAfterMs(job));
  if (schedule.kind === "interval") return intervalFirstAtOrAfter(schedule, start);
  return cronFirstAtOrAfter(schedule, start, createdAfterMs(job));
}

/**
 * Latest eligible never-started occurrence at `now`: at most one per recurring
 * job (no backlog replay). Returns null when nothing is due. A settled
 * occurrence at the same instant still counts as "floor" and must be passed
 * back to this function by the caller via `afterMs` (it already is: the floor
 * is the newest recorded due instant).
 */
export function latestDueOccurrence(
  schedule: Schedule,
  now: number,
  afterMs: number,
  job?: JobRecord,
): { dueMs: number; deadlineMs: number } | null {
  const floor = Math.max(afterMs, createdAfterMs(job));
  switch (schedule.kind) {
    case "oneshot": {
      if (now < schedule.dueMs) return null;
      return { dueMs: schedule.dueMs, deadlineMs: occurrenceDeadline(schedule, schedule.dueMs) };
    }
    case "cron": {
      const dueMs = cronLastAtOrBefore(schedule, now, floor);
      return dueMs === null ? null : { dueMs, deadlineMs: occurrenceDeadline(schedule, dueMs) };
    }
    case "interval": {
      const dueMs = intervalLastAtOrBefore(schedule, now, floor);
      return dueMs === null ? null : { dueMs, deadlineMs: occurrenceDeadline(schedule, dueMs) };
    }
  }
}

/**
 * Eligibility notice for an independently invoked manual run. It never
 * consumes the schedule; the wording reflects the durable occurrence state
 * produced by the Trigger when available (#40).
 */
export function scheduleEligibilityNotice(schedule: Schedule, nowMsValue: number, state?: ScheduleState | null): string {
  if (schedule.kind !== "oneshot") {
    const next = nextOccurrence(schedule, nowMsValue);
    const due = next === null ? "no further occurrence within the planning horizon" : new Date(next).toISOString();
    return `This is a separate manual attempt: it neither consumes nor shifts ${schedule.kind} recurrence. The next scheduled occurrence is ${due}.`;
  }
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

/** Human-readable schedule rule for plans, receipts, and show/list output. */
export function resolveScheduleLabel(schedule: Schedule): string {
  switch (schedule.kind) {
    case "oneshot": return resolvedLocal(schedule);
    case "cron": return `cron "${schedule.expr}" (${schedule.timeZone})`;
    case "interval": return `every ${schedule.intervalMinutes}m from ${new Date(schedule.anchorMs).toISOString()}`;
  }
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
  | "expired" | "overlap-skipped" | "lateness-skipped";

export interface OccurrenceState {
  id: string;
  /** Planned instant (epoch ms); eligibility and ordering derive from it. */
  dueMs: number;
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
  const job = loadJob(workspace.root, name);
  if (!existsSync(path)) {
    if (job.runs.some((run) => run.trigger === "scheduled")) {
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
  if (state.name !== name || !Array.isArray(state.occurrences)) {
    throw new AutomationError(`Schedule state for "${name}" is corrupt; it has been preserved at ${path}.`);
  }
  const ids = new Set<string>();
  let normalized = false;
  for (const entry of state.occurrences) {
    // Legacy #39/#40 ledgers predate the dueMs field; only one-shot jobs existed.
    if (entry.dueMs === undefined && job.schedule.kind === "oneshot") {
      entry.dueMs = job.schedule.dueMs;
      normalized = true;
    }
    if (!validOccurrence(entry, job.schedule, ids)) {
      throw new AutomationError(`Schedule state for "${name}" is corrupt; it has been preserved at ${path}.`);
    }
    ids.add(entry.id);
  }
  if (job.schedule.kind === "oneshot" && state.occurrences.length !== 1) {
    throw new AutomationError(`Schedule state for "${name}" is corrupt; it has been preserved at ${path}.`);
  }
  if (normalized) saveScheduleState(workspace, state);
  return state;
}

const OCCURRENCE_OUTCOMES = ["completed", "failed", "timeout", "unknown", "expired", "overlap-skipped", "lateness-skipped"];

function validOccurrence(entry: OccurrenceState | null, schedule: Schedule, ids: Set<string>): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (typeof entry.id !== "string" || !entry.id || ids.has(entry.id)) return false;
  if (!Number.isSafeInteger(entry.dueMs) || !Number.isFinite(new Date(entry.dueMs).getTime())) return false;
  if (entry.id !== occurrenceId(schedule, entry.dueMs)) return false;
  if (entry.childPid !== undefined && (!Number.isSafeInteger(entry.childPid) || entry.childPid <= 0)) return false;
  if (entry.runId !== undefined && (typeof entry.runId !== "string" || !entry.runId)) return false;
  if (entry.startedAt !== undefined && (typeof entry.startedAt !== "string" || !Number.isFinite(Date.parse(entry.startedAt)))) return false;
  if (entry.exitCode !== undefined && entry.exitCode !== null && !Number.isInteger(entry.exitCode)) return false;
  if (entry.status === "running") return !!entry.runId && !!entry.startedAt && entry.outcome === undefined;
  return entry.status === "settled" && typeof entry.outcome === "string"
    && OCCURRENCE_OUTCOMES.includes(entry.outcome)
    && typeof entry.endedAt === "string" && Number.isFinite(Date.parse(entry.endedAt));
}

export function saveScheduleState(workspace: Workspace, state: ScheduleState): void {
  atomicWriteJson(scheduleStatePath(workspace, state.name), state);
}

/** The occurrence for one due instant, or null when nothing is recorded. */
export function findOccurrence(state: ScheduleState | null, id: string): OccurrenceState | null {
  return state?.occurrences.find((entry) => entry.id === id) ?? null;
}

/** Highest planned instant recorded for a job, or -Infinity for a fresh ledger. */
export function recordedFloor(state: ScheduleState | null): number {
  return state ? state.occurrences.reduce((max, entry) => Math.max(max, entry.dueMs), -Infinity) : -Infinity;
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

/**
 * Durably mark many never-started occurrences settled in one atomic write
 * (Trigger coalescing skips an older backlog this way). Existing entries are
 * left untouched. The resulting state is validated on the next load.
 */
export function settleOccurrencesBulk(workspace: Workspace, name: string, entries: Array<{ id: string; dueMs: number; outcome: OccurrenceOutcome }>): void {
  if (entries.length === 0) return;
  const state = loadScheduleState(workspace, name) ?? { version: STATE_VERSION, name, occurrences: [] };
  const known = new Set(state.occurrences.map((entry) => entry.id));
  const endedAt = new Date(nowMs()).toISOString();
  for (const entry of entries) {
    if (known.has(entry.id)) continue;
    state.occurrences.push({
      id: entry.id, dueMs: entry.dueMs, status: "settled", outcome: entry.outcome,
      endedAt, exitCode: null,
    });
  }
  state.occurrences.sort((a, b) => a.dueMs - b.dueMs);
  saveScheduleState(workspace, state);
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
    || !validStoredSchedule(schedule)
    || !Array.isArray(record.runs) || !record.runs.every(validRunSummary)) {
    throw new AutomationError(`Job record for "${name}" is corrupt; it has been preserved at ${path}.`);
  }
  return record;
}

const boundedMinutes = (value: unknown): boolean =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) * 60000 <= 2147483647;

function validStoredSchedule(schedule: Schedule | null | undefined): boolean {
  if (!schedule || typeof schedule !== "object") return false;
  if (schedule.kind === "oneshot") {
    if (!Number.isSafeInteger(schedule.dueMs) || !Number.isFinite(new Date(schedule.dueMs).getTime())
      || !boundedMinutes(schedule.latenessMinutes)
      || typeof schedule.wall !== "string" || typeof schedule.timeZone !== "string"
      || (schedule.offset !== null && typeof schedule.offset !== "string")) return false;
    try { return parseOneShot(schedule.wall + (schedule.offset ?? ""), schedule.timeZone).dueMs === schedule.dueMs; }
    catch { return false; } // unparseable stored wall time is corruption, not a crash
  }
  if (schedule.kind === "cron") {
    if (typeof schedule.expr !== "string" || typeof schedule.timeZone !== "string"
      || (schedule.catchUpMinutes !== null && !boundedMinutes(schedule.catchUpMinutes))) return false;
    try { return parseCron(schedule.expr, schedule.timeZone).expr === schedule.expr; }
    catch { return false; } // unparseable stored cron expression is corruption, not a crash
  }
  if (schedule.kind === "interval") {
    return boundedMinutes(schedule.intervalMinutes)
      && Number.isSafeInteger(schedule.anchorMs) && Number.isFinite(new Date(schedule.anchorMs).getTime())
      && (schedule.catchUpMinutes === null || boundedMinutes(schedule.catchUpMinutes));
  }
  return false;
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
