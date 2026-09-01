import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

type SettingsScope = "global" | "project";
interface SettingsStorage { withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void; }

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
    const deadline = Date.now() + 5000;
    let descriptor: number | undefined;
    while (descriptor === undefined) {
      try {
        descriptor = openSync(lock, "wx", 0o600);
        writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let stale = false;
        try {
          const owner = JSON.parse(readFileSync(lock, "utf8")) as { pid?: number; createdAt?: number };
          if (!owner.pid || !owner.createdAt || Date.now() - owner.createdAt > 30_000) stale = true;
          else try { process.kill(owner.pid, 0); } catch (failure) { stale = (failure as NodeJS.ErrnoException).code === "ESRCH"; }
        } catch { stale = true; }
        if (stale) { rmSync(lock, { force: true }); continue; }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for Feishu settings lock: ${lock}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
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
      rmSync(lock, { force: true });
    }
  }
}

export function settingsManagerFor(agentHome: string, projectRoot: string): SettingsManager {
  return SettingsManager.fromStorage(new FeishuSettingsStorage(agentHome, projectRoot), { projectTrusted: true });
}
