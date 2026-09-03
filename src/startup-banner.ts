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

const BIRD = 0x2588; // █

// Feishu hummingbird, traced from the official icon: a blue body in an
// up-right flying swoosh with a teal/green upper wing band and green tail tip.
// theme accent = blue, success = green. Grid columns are fixed at BIRD_COLS
// (plain-visible width) so the text column aligns regardless of ANSI codes.
const BIRD_COLS = 16;
const BIRD_GRID: string[] = [
  "        BBBBBBBB",
  "    GGBBBBBBGGGG",
  "GGGBBBBBBBBBBBBB",
];

function birdLine(row: string, theme: { fg(c: ThemeColor, t: string): string }): string {
  let out = "";
  for (const cell of [...row]) {
    if (cell === "B") out += theme.fg("accent", String.fromCodePoint(BIRD));
    else if (cell === "G") out += theme.fg("success", String.fromCodePoint(BIRD));
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
          const gap = "   ";
          const text = [
            `${a("Feishu Agent")} ${dim(`v${version}`)}`,
            muted(model ? `${model}  ${dim("·")}  ${shortCwd()}` : shortCwd()),
            dim("/ commands · ? help · /quit exit"),
          ];
          return [
            "",
            `${bird[0]}${gap}${text[0]}`,
            `${bird[1]}${gap}${text[1]}`,
            `${bird[2]}${gap}${text[2]}`,
            "",
          ];
        },
        invalidate() {},
      }));
    });
  };
}
