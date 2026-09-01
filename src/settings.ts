import { randomUUID } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

type SettingsScope = "global" | "project";
interface SettingsStorage { withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void; }

const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 25;
const LOCK_CREATION_GRACE_MS = 1_000;
const INVALID_LOCK_STALE_MS = 30_000;

interface LockOwner { pid?: unknown; createdAt?: unknown; token?: unknown; }

function validOwner(owner: LockOwner): { pid: number; createdAt: number; token?: string } | undefined {
  const pid = typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0 ? owner.pid : undefined;
  const createdAt = typeof owner.createdAt === "number" && Number.isFinite(owner.createdAt) && owner.createdAt > 0 ? owner.createdAt : undefined;
  const token = typeof owner.token === "string" && owner.token ? owner.token : undefined;
  return pid !== undefined && createdAt !== undefined ? { pid, createdAt, token } : undefined;
}

function ownerIsAlive(pid: number): boolean | undefined {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return undefined;
  }
}

function staleLockCanBeReaped(lock: string): boolean {
  let age: number;
  try { age = Date.now() - statSync(lock).mtimeMs; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }

  let owner: LockOwner;
  try { owner = JSON.parse(readFileSync(lock, "utf8")) as LockOwner; }
  catch { return age >= Math.max(LOCK_CREATION_GRACE_MS, INVALID_LOCK_STALE_MS); }

  const valid = validOwner(owner);
  if (valid) {
    const alive = ownerIsAlive(valid.pid);
    if (alive !== false) return false;
    return true;
  }
  return age >= Math.max(LOCK_CREATION_GRACE_MS, INVALID_LOCK_STALE_MS);
}

function reapStaleLock(lock: string): boolean {
  const claim = `${lock}.reap`;
  try { linkSync(lock, claim); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    if (code === "EEXIST") return false;
    throw error;
  }
  try {
    const current = statSync(lock);
    const claimed = statSync(claim);
    if (current.dev !== claimed.dev || current.ino !== claimed.ino || !staleLockCanBeReaped(claim)) return false;
    rmSync(lock);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  } finally { rmSync(claim, { force: true }); }
}

export class FeishuSettingsStorage implements SettingsStorage {
  readonly globalPath: string;
  readonly projectPath: string;

  constructor(agentHome: string, projectRoot: string) {
    this.globalPath = join(agentHome, "settings.json");
    this.projectPath = join(projectRoot, ".feishu-agent", "settings.json");
  }

  withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
    const path = scope === "global" ? this.globalPath : this.projectPath;
    mkdirSync(dirname(path), { recursive: true });
    const lock = `${path}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    let descriptor: number | undefined;
    let token: string | undefined;
    while (descriptor === undefined) {
      try {
        const candidate = openSync(lock, "wx", 0o600);
        const candidateToken = randomUUID();
        try { writeFileSync(candidate, JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: candidateToken })); }
        catch (error) { closeSync(candidate); rmSync(lock, { force: true }); throw error; }
        descriptor = candidate;
        token = candidateToken;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (staleLockCanBeReaped(lock) && reapStaleLock(lock)) continue;
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for Feishu settings lock: ${lock}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
      }
    }
    try {
      let current: string | undefined;
      try { current = readFileSync(path, "utf8"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const next = fn(current);
      if (next === undefined) return;
      const temporary = `${path}.${process.pid}.tmp`;
      try { writeFileSync(temporary, next, { mode: 0o600 }); renameSync(temporary, path); }
      finally { rmSync(temporary, { force: true }); }
    } finally {
      closeSync(descriptor);
      try {
        const owner = validOwner(JSON.parse(readFileSync(lock, "utf8")) as LockOwner);
        if (owner?.token === token) rmSync(lock, { force: true });
      } catch { /* Keep a lock we can no longer prove belongs to this writer. */ }
    }
  }
}

export function settingsManagerFor(agentHome: string, projectRoot: string): SettingsManager {
  return SettingsManager.fromStorage(new FeishuSettingsStorage(agentHome, projectRoot), { projectTrusted: true });
}
