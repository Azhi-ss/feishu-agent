import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SECTIONS = ["context", "skills", "prompts", "extensions", "themes"] as const;
export const TASKS_SECTION = "tasks";
export type StartupSection = typeof SECTIONS[number] | typeof TASKS_SECTION;

function isStartupSection(item: string): item is StartupSection {
  return (SECTIONS as readonly string[]).includes(item) || item === TASKS_SECTION;
}

export interface FeishuStartup {
  banner: boolean;
  skills: "names" | "count" | "hide";
  sections: StartupSection[];
}

// The one reader of feishuStartup: the banner (what to draw) and the startup pull
// (whether to pull at all) must not drift apart on the shape of `sections`.
export function readFeishuStartup(settingsPath: string): FeishuStartup | undefined {
  let parsed: { feishuStartup?: unknown };
  try { parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as { feishuStartup?: unknown }; }
  catch { return undefined; }
  const raw = parsed.feishuStartup;
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as { banner?: unknown; skills?: unknown; sections?: unknown };
  const sections = Array.isArray(value.sections)
    ? value.sections.filter((item): item is StartupSection => typeof item === "string" && isStartupSection(item))
    : [...SECTIONS];
  const skills = value.skills === "count" || value.skills === "hide" || value.skills === "names" ? value.skills : "names";
  return { banner: value.banner !== false, skills, sections };
}

export function tasksSectionEnabled(agentHome: string): boolean {
  return readFeishuStartup(join(agentHome, "settings.json"))?.sections.includes(TASKS_SECTION) ?? false;
}
