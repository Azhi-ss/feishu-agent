import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { truncateToWidth } = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("@earendil-works/pi-tui") as {
  truncateToWidth: (text: string, maxWidth: number) => string;
};
import type { ExtensionAPI, ExtensionFactory, ThemeColor } from "@earendil-works/pi-coding-agent";
import { readTaskRecords, taskBannerRows } from "./tasks.js";

export interface StartupInventory {
  context: string[];
  skills: string[];
  prompts: string[];
  extensions: string[];
  themes: string[];
}

const SECTIONS = ["context", "skills", "prompts", "extensions", "themes"] as const;
const TASKS_SECTION = "tasks";
type StartupSection = typeof SECTIONS[number] | typeof TASKS_SECTION;

function isStartupSection(item: string): item is StartupSection {
  return (SECTIONS as readonly string[]).includes(item) || item === TASKS_SECTION;
}

export interface FeishuStartup {
  banner: boolean;
  skills: "names" | "count" | "hide";
  sections: StartupSection[];
}

// One-shot startup banner: replaces Pi's built-in header once at launch.
// The header renders at the top of the transcript and scrolls away with it
// (it is not a fixed bar), so cost after startup is zero.
function feishuVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = readFileSync(join(here, "..", "..", "package.json"), "utf8");
    return (JSON.parse(pkg) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function shortCwd(): string {
  const home = process.env.HOME ?? "";
  const cwd = process.cwd();
  if (home && cwd.startsWith(home + "/")) return `~${cwd.slice(home.length)}`;
  return cwd;
}

// Small fixed mark made from single-cell geometric Unicode. It is intentionally
// an abstraction of the bird, not a coarse raster of the source image. Colors
// follow the active theme so the mark stays coherent with any skin.
type BirdPart = [color: ThemeColor, text: string];
const BIRD_LINES: BirdPart[][] = [
  [["mdLink", "  ◢◤"]],
  [["accent", " ◢█◤"]],
  [["dim", "    "]],
];

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

function agentHomeDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".feishu-agent");
}

function startupSettingsPath(): string {
  return join(agentHomeDir(), "settings.json");
}

function sectionLine(label: string, items: string[], skillsMode: FeishuStartup["skills"], section: StartupSection): string | undefined {
  if (section === "skills" && skillsMode === "hide") return undefined;
  const body = section === "skills" && skillsMode === "count" ? String(items.length) : items.join(", ");
  if (!body) return undefined;
  return `  ${label.padEnd(12)} ${body}`;
}

export function startupBannerExtension(inventory: () => StartupInventory = () => ({ context: [], skills: [], prompts: [], extensions: [], themes: [] })): ExtensionFactory {
  const version = feishuVersion();
  return (pi: ExtensionAPI) => {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.mode !== "tui") return;
      ctx.ui.setHeader((_tui, theme) => ({
        render(width: number): string[] {
          const paint = (color: ThemeColor, text: string) => process.env.NO_COLOR ? text : theme.fg(color, text);
          const a = (t: string) => paint("accent", t);
          const muted = (t: string) => paint("muted", t);
          const dim = (t: string) => paint("dim", t);
          const model = (ctx as { model?: { id?: string } }).model?.id ?? "";
          const display = readFeishuStartup(startupSettingsPath());
          const lines: string[] = [""];
          if (!display || display.banner) {
            const bird = BIRD_LINES.map((parts) => parts.map(([color, text]) => paint(color, text)).join(""));
            const text = [
              `${a("Feishu Agent")} ${dim(`v${version}`)}`,
              muted(model ? `${model}  ${dim("·")}  ${shortCwd()}` : shortCwd()),
              dim("/ commands · ? help · /quit exit"),
            ];
            lines.push(`${bird[0]}   ${text[0]}`.trimEnd(), `${bird[1]}   ${text[1]}`.trimEnd(), `${bird[2]}   ${text[2]}`.trimEnd(), "");
          }
          if (display) {
            const data = inventory();
            const rows: Array<[StartupSection, string, string[]]> = [
              ["context", "Context", data.context],
              ["skills", "Skills", data.skills],
              ["prompts", "Prompts", data.prompts],
              ["extensions", "Extensions", data.extensions],
              ["themes", "Themes", data.themes],
            ];
            for (const [section, label, items] of rows) {
              if (!display.sections.includes(section)) continue;
              const line = sectionLine(label, items, display.skills, section);
              if (line) lines.push(dim(line));
            }
            if (display.sections.includes(TASKS_SECTION)) {
              taskBannerRows(readTaskRecords(agentHomeDir())).forEach((row, index) => {
                lines.push(dim(`  ${(index === 0 ? "Tasks" : "").padEnd(12)} ${row}`));
              });
            }
            if (lines.at(-1) !== "") lines.push("");
          }
          return lines.map((line) => truncateToWidth(line, width));
        },
        invalidate() {},
      }));
    });
  };
}
