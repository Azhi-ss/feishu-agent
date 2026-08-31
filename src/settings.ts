import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
    let current: string | undefined;
    try { current = readFileSync(path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next = fn(current);
    if (next === undefined) return;
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    try { writeFileSync(temporary, next, { mode: 0o600 }); renameSync(temporary, path); }
    finally { rmSync(temporary, { force: true }); }
  }
}

export function settingsManagerFor(agentHome: string, projectRoot: string): SettingsManager {
  return SettingsManager.fromStorage(new FeishuSettingsStorage(agentHome, projectRoot), { projectTrusted: true });
}
