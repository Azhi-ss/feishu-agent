import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { memoryConfig } from "./memory.js";
import { DEFAULT_SKILLS } from "./default-skills.js";

export const DEFAULT_SYSTEM = `You are Feishu Agent, the dedicated assistant operating Feishu Runtime for this Feishu Project.
Use Feishu Skills and optional Long-term Memory while preserving Lark Identity. A destructive lark-cli write (delete/remove/revoke/withdraw) may carry --yes only when the user's current-turn request explicitly asks for that kind of action; otherwise let lark-cli's own confirmation prompt run.
You may inspect project material and create support files directly serving a Feishu deliverable or lark-cli workflow. Refer unrelated general software development to ordinary pi.
Resource Isolation is not filesystem isolation or an OS sandbox; tools retain the current user's permissions.
Use existing lark-cli state without copying tokens. Prefer lark-cli shortcuts; inspect --help or schema for unfamiliar commands. Personal-resource operations must explicitly use --as user. Use --as bot only when the user requests Bot identity or the API requires it. Use \`/find-skill\` for third-party Skill discovery; its install target is Feishu's private \`~/.feishu-agent/skills/\`, never ordinary Pi or \`.agents\` directories.`;

function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, path);
}

export function existingIdentity(agentHome: string): string | undefined {
  try {
    const userId = (JSON.parse(readFileSync(join(agentHome, "mem0-config.json"), "utf8")) as { userId?: unknown }).userId;
    return typeof userId === "string" && userId.startsWith("feishu:") && userId.length > 7 ? userId.slice(7) : undefined;
  } catch { return undefined; }
}

function validateSystemIdentity(content: string): void {
  if (!/^\s*You are Feishu Agent\b/.test(content)) throw new Error("SYSTEM.md must preserve the protected Feishu Agent identity. Use `feishu init --reset-system` to restore it.");
}

export function initializeHome(agentHome: string, identity: string, reset: { identity?: boolean; system?: boolean } = {}): { created: string[]; identity: string } {
  if (!identity.trim()) throw new Error("Init requires an explicit stable Memory Identity.");
  const directories = ["sessions", "skills", "official-skills", ".compat/projects", "packages", "memory-state"];
  for (const directory of directories) mkdirSync(join(agentHome, directory), { recursive: true });
  const created: string[] = [];
  const system = join(agentHome, "SYSTEM.md");
  if (!existsSync(system) || reset.system) { writeFileSync(system, DEFAULT_SYSTEM + "\n"); created.push(system); }
  else validateSystemIdentity(readFileSync(system, "utf8"));
  const mem0Path = join(agentHome, "mem0-config.json");
  if (!existsSync(mem0Path) || reset.identity) { atomicJson(mem0Path, memoryConfig(identity)); created.push(mem0Path); }
  const settingsPath = join(agentHome, "settings.json");
  if (!existsSync(settingsPath)) { atomicJson(settingsPath, {}); created.push(settingsPath); }
  for (const skill of DEFAULT_SKILLS) {
    const skillPath = join(agentHome, "skills", skill.name, "SKILL.md");
    if (!existsSync(skillPath)) {
      mkdirSync(join(agentHome, "skills", skill.name), { recursive: true });
      writeFileSync(skillPath, skill.body + "\n");
      created.push(skillPath);
    }
  }
  const saved = JSON.parse(readFileSync(mem0Path, "utf8")) as { userId: string };
  return { created, identity: saved.userId };
}
