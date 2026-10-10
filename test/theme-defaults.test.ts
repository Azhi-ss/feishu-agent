import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { visibleWidth } = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("@earendil-works/pi-tui") as { visibleWidth: (text: string) => number };
import { readFeishuStartup, startupBannerExtension } from "../src/startup-banner.js";
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
  const previousNoColor = process.env.NO_COLOR;
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.NO_COLOR;
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "feishu-bird-"));
  try {
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
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
  }
});

test("feishuStartup chooses which startup lines appear", () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-startup-"));
  writeFileSync(join(root, "settings.json"), JSON.stringify({
    feishuStartup: { banner: false, skills: "count", sections: ["skills", "extensions"] },
  }));
  assert.deepEqual(readFeishuStartup(join(root, "settings.json")), {
    banner: false, skills: "count", sections: ["skills", "extensions"],
  });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const handlers: Record<string, Array<(event: unknown, ctx: unknown) => void>> = {};
  let header: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
  startupBannerExtension(() => ({ context: ["AGENTS.md"], skills: ["a", "b"], prompts: ["/council"], extensions: ["pi-hermes-memory"], themes: ["breezy-ocean"] }))({
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => { (handlers[event] ??= []).push(handler); },
  } as never);
  for (const handler of handlers.session_start ?? []) handler({}, { mode: "tui", model: { id: "m" }, ui: { setHeader: (next: typeof header) => { header = next; } } });
  const frame = header!(undefined, { fg: (_c: string, text: string) => text }).render(80).join("\n");
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  assert.doesNotMatch(frame, /Feishu Agent/);
  assert.match(frame, /Skills\s+2/);
  assert.match(frame, /pi-hermes-memory/);
  assert.doesNotMatch(frame, /AGENTS\.md|\/council|breezy-ocean/);
});

test("startup banner lines stay within the terminal width", () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-banner-width-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    feishuStartup: { sections: ["prompts", "extensions", "tasks"] },
  }));
  writeFileSync(join(dir, "tasks.json"), JSON.stringify({
    tasks: [{ name: "Write the quarterly planning note that is longer than a narrow terminal" }],
  }));
  const handlers: Record<string, Array<(event: unknown, ctx: unknown) => void>> = {};
  let header: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
  try {
    startupBannerExtension(() => ({
      context: [],
      skills: [],
      prompts: ["/council", "/gather-context-and-clarify", "/parallel-cleanup", "/parallel-research", "/parallel-review", "/review-loop"],
      extensions: ["pi-web-access", "remote-bridge.ts", "@bytetrue/pi-image-gen", "index.ts", "pi-hermes-memory"],
      themes: [],
    }))({
      on: (event: string, handler: (event: unknown, ctx: unknown) => void) => { (handlers[event] ??= []).push(handler); },
    } as never);
    for (const handler of handlers.session_start ?? []) handler({}, { mode: "tui", model: { id: "DeepSeek-V4.1-Flash" }, ui: { setHeader: (next: typeof header) => { header = next; } } });
    const lines = header!(undefined, { fg: (_color: string, text: string) => `\x1b[38;5;66m${text}\x1b[39m` }).render(113);
    for (const [index, line] of lines.entries()) {
      const width = visibleWidth(line);
      assert.ok(width <= 113, `line ${index} visible width ${width} exceeds 113: ${line}`);
    }
    assert.match(lines.join("\n"), /Prompts/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
