import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { tasksSectionEnabled } from "./startup-settings.js";

const execFileAsync = promisify(execFile);

const REFRESH_ARGS = ["task", "+get-my-tasks", "--complete=false", "--as", "user", "--page-all"] as const;
const AUTH_FAILED = "Could not refresh Feishu tasks. Run `lark-cli auth login`.";

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
export function taskBannerRows(records: TaskRecord[], now = Date.now()): string[] {
  const today = calendarDay(now, false);
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

// Explicit /tasks, `feishu tasks refresh`, or the single startup pull; /new and /reload must not call this.
// ponytail: --page-all stops at lark-cli's 40-page cap.
export async function refreshTaskList(agentHome: string): Promise<number> {
  if (!existsSync(agentHome)) throw new Error("Feishu Agent Home is missing. Run `feishu init`.");
  let stdout: string;
  try {
    const result = await execFileAsync("lark-cli", [...REFRESH_ARGS], {
      encoding: "utf8",
      env: process.env,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    const missing = typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
    if (missing) throw new Error("lark-cli was not found. Install @larksuite/cli.");
    throw new Error(AUTH_FAILED);
  }
  const tasks = parseTaskList(stdout);
  const file = join(agentHome, "tasks.json");
  const temporary = join(agentHome, `.tasks.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify({ tasks }, null, 2)}\n`);
    renameSync(temporary, file);
  } catch {
    try { rmSync(temporary, { force: true }); }
    catch { /* unpublished temp list; the previous tasks.json stays in place */ }
    throw new Error("Could not refresh Feishu tasks.");
  }
  for (const listener of [...listeners]) {
    try { listener(); }
    catch { /* the list is already on disk; a broken repaint must not fail the pull */ }
  }
  return tasks.length;
}

// The cause and its fix live in the error; the next step depends on where the pull was
// started, so each entry writes its own retry line instead of quoting the shell's.
export function taskRefreshMessage(error: unknown, retry: string): string {
  const cause = error instanceof Error && error.message ? error.message : "Could not refresh Feishu tasks.";
  return `${cause} ${retry} The previous list was kept.`;
}

const listeners = new Set<() => void>();

// Fired after a list lands on disk. The banner repaints on it; the pull itself
// knows nothing about renderers, so /tasks and startup reach it the same way.
export function onTasksChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const startupPulls = new Map<string, Promise<void>>();

// One pull per Agent Home per process, started before model load so it overlaps startup.
export function beginStartupTaskPull(agentHome: string): void {
  if (startupPulls.has(agentHome) || !tasksSectionEnabled(agentHome)) return;
  startupPulls.set(agentHome, refreshTaskList(agentHome).then(() => undefined, () => undefined)); // a failed pull keeps the previous list and still lets the TUI open
}

// The /tasks slash command belongs to the tasks domain: refresh and report. It does
// not repaint anything; the banner reacts to onTasksChanged like every other consumer.
export function tasksExtension(agentHome: string): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerCommand("tasks", {
      description: "Pull your unfinished Feishu tasks into the banner",
      handler: async (_args, ctx) => {
        try {
          const count = await refreshTaskList(agentHome);
          const message = `Pulled ${count} unfinished Feishu task${count === 1 ? "" : "s"}.`;
          if (ctx.hasUI) ctx.ui.notify(message, "info");
          else process.stdout.write(`${message}\n`);
        } catch (error) {
          const message = taskRefreshMessage(error, "Try /tasks again.");
          if (ctx.hasUI) ctx.ui.notify(message, "error");
          else process.stderr.write(`${message}\n`);
        }
      },
    });
  };
}
