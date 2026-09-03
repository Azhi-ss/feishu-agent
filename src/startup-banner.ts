import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

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

// Compact three-line mark evoking a paper plane / wing in block glyphs.
function brandMark(): string[] {
  return [
    "  ▜▛     ",
    " ▟███▙   ",
    "▜██████▌ ",
  ];
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
          const mark = brandMark().map((line) => a(line));
          const text = [
            `${a("Feishu Agent")} ${dim(`v${version}`)}`,
            muted(model ? `${model}  ${dim("·")}  ${shortCwd()}` : shortCwd()),
            dim("/ commands · ? help · /quit exit"),
          ];
          const height = Math.max(mark.length, text.length);
          const lines: string[] = [];
          for (let i = 0; i < height; i++) {
            lines.push(`${mark[i] ?? "".padEnd(10, " ")}${text[i] ?? ""}`.trimEnd());
          }
          return ["", ...lines, ""];
        },
        invalidate() {},
      }));
    });
  };
}
