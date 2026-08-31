import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { checkReadiness } from "../src/readiness.js";

test("readiness selects authenticated Feishu model, thinking preference, and runs doctor without changing shared files", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-ready-")); const home = join(root, "home"); const pi = join(home, ".pi", "agent"); const agent = join(home, ".feishu-agent"); const bin = join(root, "bin");
  mkdirSync(pi, { recursive: true }); mkdirSync(agent, { recursive: true }); mkdirSync(bin, { recursive: true });
  writeFileSync(join(pi, "auth.json"), '{"fake":{"type":"api_key","key":"safe-fake"}}');
  writeFileSync(join(pi, "models.json"), '{"providers":{"fake":{"baseUrl":"http://127.0.0.1:1/v1","api":"openai-completions","models":[{"id":"one"}]}}}');
  writeFileSync(join(pi, "settings.json"), '{"defaultProvider":"pi","defaultModel":"pi"}');
  writeFileSync(join(agent, "settings.json"), '{}');
  const lark = join(home, ".config", "lark-cli");
  mkdirSync(lark, { recursive: true });
  writeFileSync(join(lark, "config.json"), '{"defaultProfile":"finance"}');
  writeFileSync(join(lark, "token.json"), '{"token":"lark-sentinel"}');
  writeFileSync(join(bin, "lark-cli"), '#!/bin/sh\n[ "$1" = doctor ]\n[ "$LARK_PROFILE" = finance ]\n', { mode: 0o755 });
  const invariantPaths = [join(pi, "auth.json"), join(pi, "models.json"), join(pi, "settings.json"), join(lark, "config.json"), join(lark, "token.json")];
  const before = invariantPaths.map((path) => readFileSync(path));
  const oldPath = process.env.PATH; const oldProfile = process.env.LARK_PROFILE; process.env.PATH = `${bin}${delimiter}${oldPath}`; process.env.LARK_PROFILE = "finance"; process.env.MEM0_API_KEY = "not-logged";
  try {
    const result = await checkReadiness(home, agent, "fake/one", { createMemoryClient: () => ({ ping: async () => {} }), thinkingLevel: "medium" });
    assert.equal(result.model, "fake/one");
    assert.equal(result.thinking, "medium");
  } finally { process.env.PATH = oldPath; if (oldProfile === undefined) delete process.env.LARK_PROFILE; else process.env.LARK_PROFILE = oldProfile; }
  assert.deepEqual(invariantPaths.map((path) => readFileSync(path)), before);
  assert.match(readFileSync(join(agent, "settings.json"), "utf8"), /"defaultThinkingLevel": "medium"/);
  assert.doesNotMatch(readFileSync(join(agent, "settings.json"), "utf8"), /not-logged|lark-sentinel/);
});

test("doctor failure is distinct and includes fake doctor diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-doctor-fail-")); const home = join(root, "home"); const pi = join(home, ".pi", "agent"); const agent = join(home, ".feishu-agent"); const bin = join(root, "bin");
  mkdirSync(pi, { recursive: true }); mkdirSync(agent, { recursive: true }); mkdirSync(bin, { recursive: true });
  writeFileSync(join(pi, "auth.json"), '{"fake":{"type":"api_key","key":"safe-fake"}}');
  writeFileSync(join(pi, "models.json"), '{"providers":{"fake":{"baseUrl":"http://127.0.0.1:1/v1","api":"openai-completions","models":[{"id":"one"}]}}}');
  writeFileSync(join(agent, "settings.json"), '{}');
  writeFileSync(join(bin, "lark-cli"), '#!/bin/sh\necho "profile token expired" >&2\nexit 7\n', { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${bin}${delimiter}${oldPath}`; process.env.MEM0_API_KEY = "secret";
  try { await assert.rejects(checkReadiness(home, agent, "fake/one", { createMemoryClient: () => ({ ping: async () => {} }) }), /Lark doctor failed \(exit 7\): profile token expired/); }
  finally { process.env.PATH = oldPath; }
});
