import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MemoryConfig {
  userId: string;
  autoCapture: true;
  defaultScope: "project";
  contextInjection: true;
  dream: { enabled: boolean; auto: boolean };
}

export function memoryConfig(identity: string): MemoryConfig {
  const normalized = identity.startsWith("feishu:") ? identity : `feishu:${identity}`;
  return { userId: normalized, autoCapture: true, defaultScope: "project", contextInjection: true, dream: { enabled: true, auto: true } };
}

export function writeMemoryConfig(agentHome: string, identity: string): string {
  const path = join(agentHome, "mem0-config.json");
  mkdirSync(agentHome, { recursive: true });
  writeFileSync(path, JSON.stringify(memoryConfig(identity), null, 2) + "\n", { mode: 0o600 });
  return path;
}
