import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function lockPath(home: string, appId: string): string {
  return join(home, ".cache", "feishu-remote", `${appId.replace(/[^A-Za-z0-9._-]+/g, "_")}.lock`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function holderPid(path: string): number | undefined {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function acquireRemoteLock(home: string, appId: string, pid = process.pid): { ok: true } | { ok: false; error: string } {
  const path = lockPath(home, appId);
  mkdirSync(join(home, ".cache", "feishu-remote"), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${pid}\n`, { flag: "wx" });
      return { ok: true };
    } catch {
      const holder = holderPid(path);
      if (holder && holder !== pid && isAlive(holder)) {
        return { ok: false, error: `Remote bridge is already running (pid ${holder}). Stop that session first.` };
      }
      try { unlinkSync(path); } catch { /* retry create */ }
    }
  }
  return { ok: false, error: `Remote bridge could not acquire the lock for app ${appId}.` };
}

export function releaseRemoteLock(home: string, appId: string, pid = process.pid): void {
  const path = lockPath(home, appId);
  if (holderPid(path) === pid) {
    try { unlinkSync(path); } catch { /* already released */ }
  }
}
