import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { checkReadiness } from "../src/readiness.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "feishu-model-choice-"));
  const home = join(root, "home"); const pi = join(home, ".pi", "agent"); const agent = join(home, ".feishu-agent"); const bin = join(root, "bin");
  mkdirSync(pi, { recursive: true }); mkdirSync(agent, { recursive: true }); mkdirSync(bin, { recursive: true });
  writeFileSync(join(pi, "auth.json"), '{"fake":{"type":"api_key","key":"safe-fake"}}');
  writeFileSync(join(pi, "models.json"), '{"providers":{"fake":{"baseUrl":"http://127.0.0.1:1/v1","api":"openai-completions","models":[{"id":"one"},{"id":"two"}]}}}');
  writeFileSync(join(agent, "settings.json"), '{}');
  writeFileSync(join(bin, "lark-cli"), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { home, agent, bin };
}

test("readiness requires explicit choice with multiple models and resets only explicitly", async () => {
  const f = fixture(); const oldPath = process.env.PATH; process.env.PATH = `${f.bin}${delimiter}${oldPath}`; process.env.MEM0_API_KEY = "secret";
  const options = { createMemoryClient: () => ({ ping: async () => {} }) };
  try {
    await assert.rejects(checkReadiness(f.home, f.agent, undefined, options), /Select an authenticated model explicitly/);
    assert.equal((await checkReadiness(f.home, f.agent, "fake/two", options)).model, "fake/two");
    assert.equal((await checkReadiness(f.home, f.agent, "fake/one", options)).model, "fake/two");
    assert.equal((await checkReadiness(f.home, f.agent, "fake/one", { ...options, resetModel: true })).model, "fake/one");
  } finally { process.env.PATH = oldPath; }
  assert.doesNotMatch(readFileSync(join(f.agent, "settings.json"), "utf8"), /secret/);
});
