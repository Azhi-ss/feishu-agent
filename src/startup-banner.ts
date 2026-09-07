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

// Small fixed mark made from single-cell geometric Unicode. It is intentionally
// an abstraction of the bird, not a coarse raster of the source image. Colors
// follow the active theme so the mark stays coherent with any skin.
type BirdPart = [color: ThemeColor, text: string];
const BIRD_LINES: BirdPart[][] = [
  [["mdLink", "  ◢◤"]],
  [["accent", " ◢█◤"]],
  [["dim", "    "]],
];

export function startupBannerExtension(): ExtensionFactory {
  const version = feishuVersion();
  return (pi: ExtensionAPI) => {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.mode !== "tui") return;
      ctx.ui.setHeader((_tui, theme) => ({
        render(_width: number): string[] {
          const paint = (color: ThemeColor, text: string) => process.env.NO_COLOR ? text : theme.fg(color, text);
          const a = (t: string) => paint("accent", t);
          const muted = (t: string) => paint("muted", t);
          const dim = (t: string) => paint("dim", t);
          const model = (ctx as { model?: { id?: string } }).model?.id ?? "";
          const bird = BIRD_LINES.map((parts) => parts.map(([color, text]) => paint(color, text)).join(""));
          const text = [
            `${a("Feishu Agent")} ${dim(`v${version}`)}`,
            muted(model ? `${model}  ${dim("·")}  ${shortCwd()}` : shortCwd()),
            dim("/ commands · ? help · /quit exit"),
          ];
          return [
            "",
            `${bird[0]}   ${text[0]}`.trimEnd(),
            `${bird[1]}   ${text[1]}`.trimEnd(),
            `${bird[2]}   ${text[2]}`.trimEnd(),
            "",
          ];
        },
        invalidate() {},
      }));
    });
  };
}
