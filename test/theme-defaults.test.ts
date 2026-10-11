import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { visibleWidth } = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("@earendil-works/pi-tui") as { visibleWidth: (text: string) => number };
import { readFeishuStartup } from "../src/startup-settings.js";
import { startupBannerExtension } from "../src/startup-banner.js";
import { fakeExtensionApi, startTuiSession } from "./helpers/extension-fixture.js";
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
  delete process.env.NO_COLOR;
  try {
  const { api, handlers } = fakeExtensionApi();
  startupBannerExtension(mkdtempSync(join(tmpdir(), "feishu-bird-")))(api);

  const painted: string[] = [];
  const theme = { fg: (color: string, text: string) => { painted.push(color); return `<${color}:${text}>`; } };
  const frame = startTuiSession(handlers, { theme }).render(100);

  assert.match(frame, /Feishu Agent/);
  assert.match(frame, /fake-model/);
  // The bird mark is painted from theme tokens, not hardcoded brand RGB.
  assert.ok(painted.includes("accent") && painted.includes("mdLink"), `expected accent + mdLink bird tokens, got ${painted.join(",")}`);
  assert.doesNotMatch(frame, /\u001b\[38;(2|5)/, "no hardcoded truecolor/256-color brand escapes");
  assert.doesNotMatch(frame, /#3370FF|#00D6B9/i);
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
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
  const { api, handlers } = fakeExtensionApi();
  startupBannerExtension(root, () => ({ context: ["AGENTS.md"], skills: ["a", "b"], prompts: ["/council"], extensions: ["pi-hermes-memory"], themes: ["breezy-ocean"] }))(api);
  const frame = startTuiSession(handlers, { model: "m" }).render(80);
  assert.doesNotMatch(frame, /Feishu Agent/);
  assert.match(frame, /Skills\s+2/);
  assert.match(frame, /pi-hermes-memory/);
  assert.doesNotMatch(frame, /AGENTS\.md|\/council|breezy-ocean/);
});

test("startup banner lines stay within the terminal width", () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-banner-width-"));
  // The Agent Home is injected; PI_CODING_AGENT_DIR must not reach the banner.
  const poison = mkdtempSync(join(tmpdir(), "feishu-banner-poison-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = poison;
  writeFileSync(join(poison, "settings.json"), JSON.stringify({ feishuStartup: { sections: ["tasks"] } }));
  writeFileSync(join(poison, "tasks.json"), JSON.stringify({ tasks: [{ name: "ENV-LEAKED-TASK" }] }));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    feishuStartup: { sections: ["prompts", "extensions", "tasks"] },
  }));
  writeFileSync(join(dir, "tasks.json"), JSON.stringify({
    tasks: [{ name: "Write the quarterly planning note that is longer than a narrow terminal" }],
  }));
  const { api, handlers } = fakeExtensionApi();
  startupBannerExtension(dir, () => ({
    context: [],
    skills: [],
    prompts: ["/council", "/gather-context-and-clarify", "/parallel-cleanup", "/parallel-research", "/parallel-review", "/review-loop"],
    extensions: ["pi-web-access", "remote-bridge.ts", "@bytetrue/pi-image-gen", "index.ts", "pi-hermes-memory"],
    themes: [],
  }))(api);
  try {
    const lines = startTuiSession(handlers, {
      model: "DeepSeek-V4.1-Flash",
      theme: { fg: (_color: string, text: string) => `\x1b[38;5;66m${text}\x1b[39m` },
    }).render(113).split("\n");
    for (const [index, line] of lines.entries()) {
      const width = visibleWidth(line);
      assert.ok(width <= 113, `line ${index} visible width ${width} exceeds 113: ${line}`);
    }
    assert.match(lines.join("\n"), /Prompts/);
    assert.doesNotMatch(lines.join("\n"), /ENV-LEAKED-TASK/);
  } finally {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
  }
});
