import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionFactory, ThemeColor } from "@earendil-works/pi-coding-agent";

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

// 16x8 sample of the supplied 45x42 Feishu icon. G = teal upper wing,
// B = blue body and lower wing/tail. Keep only the two visible brand colors.
const BIRD_GRID = [
  "   GGGGGGG      ",
  "    GGGGGGG     ",
  "     GGGGGGBBB  ",
  " BBB   GGGBBBBB ",
  " BBBBB BBBBBBB  ",
  " BBBBBBBBBBBB   ",
  " BBBBBBBBBBB    ",
  "  BBBBBBBB      ",
] as const;

function birdLine(row: string, theme: { fg(c: ThemeColor, t: string): string }): string {
  let out = "";
  for (const cell of row) {
    if (cell === "B") out += theme.fg("accent", "█");
    else if (cell === "G") out += theme.fg("success", "█");
    else out += " ";
  }
  return out;
}

export function startupBannerExtension(): ExtensionFactory {
  const version = feishuVersion();
  return (pi: ExtensionAPI) => {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.mode !== "tui") return;
      ctx.ui.setHeader((_tui, theme) => ({
        render(_width: number): string[] {
          const a = (t: string) => theme.fg("accent", t);
          const muted = (t: string) => theme.fg("muted", t);
          const dim = (t: string) => theme.fg("dim", t);
          const model = (ctx as { model?: { id?: string } }).model?.id ?? "";
          const bird = BIRD_GRID.map((row) => birdLine(row, theme));
          const text = [
            `${a("Feishu Agent")} ${dim(`v${version}`)}`,
            muted(model ? `${model}  ${dim("·")}  ${shortCwd()}` : shortCwd()),
            dim("/ commands · ? help · /quit exit"),
          ];
          const textStart = Math.floor((bird.length - text.length) / 2);
          return [
            "",
            ...bird.map((line, i) => `${line}   ${text[i - textStart] ?? ""}`.trimEnd()),
            "",
          ];
        },
        invalidate() {},
      }));
    });
  };
}
