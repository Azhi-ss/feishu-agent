import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface RemoteLockHolder {
  pid: number;
  startedAt: string;
  cwd?: string;
}

function cacheDir(home: string): string {
  return join(home, ".cache", "feishu-remote");
}

function lockPath(home: string, appId: string): string {
  return join(cacheDir(home), `${appId.replace(/[^A-Za-z0-9._-]+/g, "_")}.lock`);
}

/** A handoff request lives next to the lock as `<appId>.yield` for up to ~15s. */
function yieldPath(home: string, appId: string): string {
  return join(cacheDir(home), `${appId.replace(/[^A-Za-z0-9._-]+/g, "_")}.yield`);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read the lock; accepts both JSON metadata and the legacy plain-pid format. */
export function readRemoteLock(home: string, appId: string): RemoteLockHolder | undefined {
  let raw: string;
  try {
    raw = readFileSync(lockPath(home, appId), "utf8").trim();
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown; cwd?: unknown };
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return {
        pid: parsed.pid,
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
        ...(typeof parsed.cwd === "string" ? { cwd: parsed.cwd } : {}),
      };
    }
  } catch {
    // Not JSON — the legacy format is a bare pid line, handled below.
  }
  const legacyPid = Number(raw);
  return Number.isInteger(legacyPid) && legacyPid > 0 ? { pid: legacyPid, startedAt: "" } : undefined;
}

/** Human-readable holder label for lock-conflict messages, e.g. "pid 12345 in feishu-agent". */
export function describeHolder(holder: RemoteLockHolder): string {
  const where = holder.cwd ? ` in ${basename(holder.cwd)}` : "";
  return `pid ${holder.pid}${where}`;
}

function holderPid(home: string, appId: string): number | undefined {
  return readRemoteLock(home, appId)?.pid;
}

export function acquireRemoteLock(home: string, appId: string, pid = process.pid, cwd = process.cwd()): { ok: true } | { ok: false; error: string } {
  const path = lockPath(home, appId);
  mkdirSync(cacheDir(home), { recursive: true });
  const metadata = (): string => `${JSON.stringify({ pid, startedAt: new Date().toISOString(), cwd })}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, metadata(), { flag: "wx" });
      return { ok: true };
    } catch {
      const holder = readRemoteLock(home, appId);
      if (holder && holder.pid !== pid && isAlive(holder.pid)) {
        return { ok: false, error: `Remote bridge is already running (${describeHolder(holder)}). Stop that session first, or run /remote switch here.` };
      }
      try { unlinkSync(path); } catch { /* retry create */ }
    }
  }
  return { ok: false, error: `Remote bridge could not acquire the lock for app ${appId}.` };
}

export function releaseRemoteLock(home: string, appId: string, pid = process.pid): void {
  const path = lockPath(home, appId);
  if (holderPid(home, appId) === pid) {
    try { unlinkSync(path); } catch { /* already released */ }
  }
  // A handoff request is consumed when the bridge stops for any reason.
  try { unlinkSync(yieldPath(home, appId)); } catch { /* none pending */ }
}

/** Poll until the lock for appId is gone; false on timeout. */
export async function waitForRemoteLockRelease(home: string, appId: string, timeoutMs = 10_000, intervalMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(lockPath(home, appId))) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return !existsSync(lockPath(home, appId));
}

/**
 * Request the live lock holder to hand the bridge over. Instead of signaling
 * the other process (SIGUSR2 interrupts the TUI's raw-mode stdin read), this
 * writes a short-lived yield file that the holder polls for on its own event
 * loop and stops gracefully. No PID reuse risk: nothing is signaled.
 */
export function requestRemoteHandover(home: string, appId: string): boolean {
  const holder = readRemoteLock(home, appId);
  if (!holder || !isAlive(holder.pid)) return false;
  mkdirSync(cacheDir(home), { recursive: true });
  writeFileSync(yieldPath(home, appId), JSON.stringify({ at: Date.now(), requesterPid: process.pid }));
  return true;
}

/** Holder-side: a fresh (<15s) handoff request written by ANOTHER process is present. */
export function hasHandoffRequest(home: string, appId: string, selfPid = process.pid): boolean {
  try {
    const raw = JSON.parse(readFileSync(yieldPath(home, appId), "utf8")) as { at?: unknown; requesterPid?: unknown };
    if (typeof raw.requesterPid === "number" && raw.requesterPid === selfPid) return false; // our own request
    return typeof raw.at === "number" && Date.now() - raw.at < 15_000;
  } catch {
    return false;
  }
}

/** Clear a handoff request (called when the holder stops for any reason). */
export function clearHandoffRequest(home: string, appId: string): void {
  try { unlinkSync(yieldPath(home, appId)); } catch { /* none pending */ }
}
