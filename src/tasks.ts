import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REFRESH_ARGS = ["task", "+get-my-tasks", "--complete=false", "--as", "user", "--page-all"] as const;
const AUTH_FAILED = "Could not refresh Feishu tasks. Run `lark-cli auth login`, then `feishu tasks refresh`. The previous list was kept.";

export interface TaskRecord {
  name: string;
  due?: number;
  allDay?: boolean;
}

export function readTaskRecords(agentHome: string): TaskRecord[] {
  let text: string;
  try { text = readFileSync(join(agentHome, "tasks.json"), "utf8"); }
  catch { return []; } // missing tasks.json: omit the Tasks section
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return []; } // corrupt tasks.json: omit Tasks instead of breaking the TUI
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { tasks?: unknown }).tasks)) return [];
  const records: TaskRecord[] = [];
  for (const item of (parsed as { tasks: unknown[] }).tasks) {
    if (!item || typeof item !== "object") continue;
    const name = (item as { name?: unknown }).name;
    if (typeof name !== "string" || !name.trim()) continue;
    const record: TaskRecord = { name: name.trim() };
    const due = (item as { due?: unknown }).due;
    if (typeof due === "number" && Number.isFinite(due)) {
      record.due = due;
      record.allDay = (item as { allDay?: unknown }).allDay === true;
    }
    records.push(record);
  }
  return records;
}

function calendarDay(ms: number, utc: boolean): string {
  const date = new Date(ms);
  const year = utc ? date.getUTCFullYear() : date.getFullYear();
  const month = (utc ? date.getUTCMonth() : date.getMonth()) + 1;
  const day = utc ? date.getUTCDate() : date.getDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function shortDate(day: string, today: string): string {
  const [year, month, date] = day.split("-");
  const [todayYear] = today.split("-");
  return year === todayYear ? `${Number(month)}/${Number(date)}` : `${year}/${Number(month)}/${Number(date)}`;
}

// Overdue, due today, future, then undated. Future sits between today and undated
// so every unfinished name still appears. ponytail: local calendar day, no per-zone clock.
// More than five tasks stays five lines: four names, then +N for the rest.
export function taskBannerRows(records: TaskRecord[]): string[] {
  const today = calendarDay(Date.now(), false);
  const ranked = records.map((record, index) => {
    if (record.due === undefined) return { record, rank: 3, day: "", index };
    const day = calendarDay(record.due, record.allDay === true);
    const rank = day < today ? 0 : day === today ? 1 : 2;
    return { record, rank, day, index };
  });
  ranked.sort((left, right) => left.rank - right.rank || left.day.localeCompare(right.day) || left.index - right.index);
  const shown = ranked.length > 5 ? 4 : ranked.length;
  const rows = ranked.slice(0, shown).map((entry) => entry.day ? `${entry.record.name} ${shortDate(entry.day, today)}` : entry.record.name);
  if (ranked.length > shown) rows.push(`+${ranked.length - shown}`);
  return rows;
}

function isCompleted(value: unknown): boolean {
  if (typeof value === "number") return value > 0;
  if (typeof value !== "string" || !value.trim() || value === "0") return false;
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0;
}

function dueMillis(due: unknown): { ms: number; allDay: boolean } | undefined {
  if (!due || typeof due !== "object") return undefined;
  const timestamp = (due as { timestamp?: unknown }).timestamp;
  const ms = typeof timestamp === "number" ? timestamp : typeof timestamp === "string" ? Number(timestamp) : NaN;
  if (!Number.isFinite(ms)) return undefined;
  return { ms, allDay: (due as { is_all_day?: unknown }).is_all_day === true };
}

function parseTaskList(stdout: string): TaskRecord[] {
  let payload: unknown;
  try { payload = JSON.parse(stdout); }
  catch { throw new Error(AUTH_FAILED); }
  const root = payload && typeof payload === "object" ? payload as { ok?: unknown; identity?: unknown; data?: unknown } : undefined;
  const data = root?.data && typeof root.data === "object" ? root.data as { items?: unknown } : undefined;
  if (!root || root.ok === false || root.identity !== "user" || !Array.isArray(data?.items)) throw new Error(AUTH_FAILED);
  const items = data.items;
  const tasks: TaskRecord[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as { summary?: unknown; completed_at?: unknown; due?: unknown };
    if (typeof record.summary !== "string" || !record.summary.trim() || isCompleted(record.completed_at)) continue;
    const stored: TaskRecord = { name: record.summary.trim() };
    const due = dueMillis(record.due);
    if (due) {
      stored.due = due.ms;
      stored.allDay = due.allDay;
    }
    tasks.push(stored);
  }
  return tasks;
}

// Explicit user command only. Startup, /new, and /reload must not call this.
// ponytail: --page-all stops at lark-cli's 40-page cap.
export function refreshTaskList(agentHome: string): number {
  if (!existsSync(agentHome)) throw new Error("Feishu Agent Home is missing. Run `feishu init`, then `feishu tasks refresh`. The previous list was kept.");
  let stdout: string;
  try {
    stdout = execFileSync("lark-cli", [...REFRESH_ARGS], {
      encoding: "utf8",
      env: process.env,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const missing = typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
    if (missing) throw new Error("lark-cli was not found. Install @larksuite/cli, then run `feishu tasks refresh`. The previous list was kept.");
    throw new Error(AUTH_FAILED);
  }
  const tasks = parseTaskList(stdout);
  const file = join(agentHome, "tasks.json");
  const temporary = join(agentHome, `.tasks.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify({ tasks }, null, 2)}\n`);
  try { renameSync(temporary, file); }
  catch {
    try { rmSync(temporary, { force: true }); }
    catch { /* unpublished temp list; the previous tasks.json stays in place */ }
    throw new Error("Could not refresh Feishu tasks. Run `feishu tasks refresh`. The previous list was kept.");
  }
  return tasks.length;
}
