import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { memoryConfig } from "./memory.js";

export const DEFAULT_SYSTEM = `You are Feishu Agent, the dedicated assistant for Feishu deliverables and lark-cli workflows. Refer unrelated software development to ordinary pi. Resource Isolation is not an OS sandbox.`;

function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, path);
}

export function initializeHome(agentHome: string, identity: string, reset: { identity?: boolean; system?: boolean } = {}): { created: string[]; identity: string } {
  if (!identity.trim()) throw new Error("Init requires an explicit stable Memory Identity.");
  const directories = ["sessions", "skills", "official-skills", ".compat/projects", "packages", "memory-state"];
  for (const directory of directories) mkdirSync(join(agentHome, directory), { recursive: true });
  const created: string[] = [];
  const system = join(agentHome, "SYSTEM.md");
  if (!existsSync(system) || reset.system) { writeFileSync(system, DEFAULT_SYSTEM + "\n"); created.push(system); }
  const mem0Path = join(agentHome, "mem0-config.json");
  if (!existsSync(mem0Path) || reset.identity) { atomicJson(mem0Path, memoryConfig(identity)); created.push(mem0Path); }
  const settingsPath = join(agentHome, "settings.json");
  if (!existsSync(settingsPath)) { atomicJson(settingsPath, {}); created.push(settingsPath); }
  const saved = JSON.parse(readFileSync(mem0Path, "utf8")) as { userId: string };
  return { created, identity: saved.userId };
}
