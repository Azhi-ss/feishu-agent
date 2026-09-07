import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startupBannerExtension } from "../src/startup-banner.js";
import { DEFAULT_THEME_NAME, ensureDefaultTheme } from "../src/settings.js";

test("ensureDefaultTheme backfills the shipped theme once and never overwrites an explicit choice", () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-theme-"));
  const settingsPath = join(root, "settings.json");

  // Missing file: created with the default.
  ensureDefaultTheme(settingsPath);
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).theme, DEFAULT_THEME_NAME);

  // Explicit choice: preserved (including built-in names and extra keys).
  writeFileSync(settingsPath, JSON.stringify({ theme: "dark", defaultModel: "m" }));
  ensureDefaultTheme(settingsPath);
  const after = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(after.theme, "dark");
  assert.equal(after.defaultModel, "m");

  // Present but without theme: backfilled without dropping other keys.
  writeFileSync(settingsPath, JSON.stringify({ defaultModel: "m2" }));
  ensureDefaultTheme(settingsPath);
  const backfilled = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(backfilled.theme, DEFAULT_THEME_NAME);
  assert.equal(backfilled.defaultModel, "m2");

  // Corrupt JSON: left untouched rather than clobbered.
  writeFileSync(settingsPath, "{not json");
  ensureDefaultTheme(settingsPath);
  assert.equal(readFileSync(settingsPath, "utf8"), "{not json");
});

test("the startup banner bird follows theme colors and ships no hardcoded brand ANSI", () => {
  const handlers: Record<string, Array<(event: unknown, ctx: unknown) => void>> = {};
  let header: ((tui: unknown, theme: unknown) => { render(width: number): string[]; invalidate(): void }) | undefined;
  const factory = startupBannerExtension();
  factory({
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
      (handlers[event] ??= []).push(handler);
    },
  } as never);

  for (const handler of handlers["session_start"] ?? []) {
    handler({}, {
      mode: "tui",
      model: { id: "fake-model" },
      ui: { setHeader: (factory2: typeof header) => { header = factory2; } },
    });
  }
  assert.ok(header, "session_start must register a header");

  const painted: string[] = [];
  const theme = { fg: (color: string, text: string) => { painted.push(color); return `<${color}:${text}>`; } };
  const lines = header!(undefined, theme).render(100);
  const frame = lines.join("\n");

  assert.match(frame, /Feishu Agent/);
  assert.match(frame, /fake-model/);
  // The bird mark is painted from theme tokens, not hardcoded brand RGB.
  assert.ok(painted.includes("accent") && painted.includes("mdLink"), `expected accent + mdLink bird tokens, got ${painted.join(",")}`);
  assert.doesNotMatch(frame, /\u001b\[38;(2|5)/, "no hardcoded truecolor/256-color brand escapes");
  assert.doesNotMatch(frame, /#3370FF|#00D6B9/i);
});
