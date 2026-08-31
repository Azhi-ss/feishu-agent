import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { checkReadiness } from "../src/readiness.js";

test("readiness selects authenticated Feishu model and runs doctor without changing Pi", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-ready-")); const home = join(root, "home"); const pi = join(home, ".pi", "agent"); const agent = join(home, ".feishu-agent"); const bin = join(root, "bin");
  mkdirSync(pi, { recursive: true }); mkdirSync(agent, { recursive: true }); mkdirSync(bin, { recursive: true });
  writeFileSync(join(pi, "auth.json"), '{"fake":{"type":"api_key","key":"safe-fake"}}');
  writeFileSync(join(pi, "models.json"), '{"providers":{"fake":{"baseUrl":"http://127.0.0.1:1/v1","api":"openai-completions","models":[{"id":"one"}]}}}');
  writeFileSync(join(pi, "settings.json"), '{"defaultProvider":"pi","defaultModel":"pi"}');
  writeFileSync(join(agent, "settings.json"), '{}');
  writeFileSync(join(bin, "lark-cli"), '#!/bin/sh\n[ "$1" = doctor ]\n', { mode: 0o755 });
  const before = readFileSync(join(pi, "settings.json"), "utf8"); const oldPath = process.env.PATH; process.env.PATH = `${bin}${delimiter}${oldPath}`; process.env.MEM0_API_KEY = "not-logged";
  try { assert.equal((await checkReadiness(home, agent, "fake/one", { createMemoryClient: () => ({ ping: async () => {} }) })).model, "fake/one"); }
  finally { process.env.PATH = oldPath; }
  assert.equal(readFileSync(join(pi, "settings.json"), "utf8"), before);
  assert.doesNotMatch(readFileSync(join(agent, "settings.json"), "utf8"), /not-logged/);
});
