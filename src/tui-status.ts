import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";

export type SkillsStatus = "ready" | "cached" | "unavailable";

const MEMORY_STATUS_KEY = "feishu-1-memory";
const SKILLS_STATUS_KEY = "feishu-2-skills";

type StatusUI = {
  setStatus?: (key: string, text: string | undefined) => void;
  theme?: { fg(color: ThemeColor, text: string): string };
};

function uiFor(ctx: ExtensionContext): StatusUI | undefined {
  return ctx.mode === "tui" ? ctx.ui as StatusUI : undefined;
}

function paint(ui: StatusUI, color: ThemeColor, text: string): string {
  if (process.env.NO_COLOR) return text;
  return ui.theme?.fg?.(color, text) ?? text;
}

export function setMemoryStatus(ctx: ExtensionContext, degraded: boolean): void {
  const ui = uiFor(ctx);
  if (!ui?.setStatus) return;
  const text = degraded ? "○ mem off" : "● mem";
  ui.setStatus(MEMORY_STATUS_KEY, paint(ui, degraded ? "warning" : "success", text));
}

export function setSkillsStatus(ctx: ExtensionContext, status: SkillsStatus): void {
  const ui = uiFor(ctx);
  if (!ui?.setStatus) return;
  const label = status === "ready" ? "ready" : status === "cached" ? "cached" : "off";
  const color = status === "ready" ? "success" : status === "cached" ? "muted" : "warning";
  ui.setStatus(SKILLS_STATUS_KEY, paint(ui, color, `│ → skills:${label}`));
}
