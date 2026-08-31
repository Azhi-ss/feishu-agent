import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeHome } from "../src/init.js";

test("init creates an idempotent private Home without overwriting choices", () => {
  const agent = join(mkdtempSync(join(tmpdir(), "feishu-init-")), ".feishu-agent");
  const first = initializeHome(agent, "alice");
  assert.equal(first.identity, "feishu:alice");
  const custom = "CUSTOM SYSTEM\n"; writeFileSync(join(agent, "SYSTEM.md"), custom);
  const settings = '{"defaultProvider":"fake","defaultModel":"one"}\n'; writeFileSync(join(agent, "settings.json"), settings);
  const second = initializeHome(agent, "bob");
  assert.equal(second.identity, "feishu:alice");
  assert.equal(readFileSync(join(agent, "SYSTEM.md"), "utf8"), custom);
  assert.equal(readFileSync(join(agent, "settings.json"), "utf8"), settings);
  const reset = initializeHome(agent, "bob", { identity: true, system: true });
  assert.equal(reset.identity, "feishu:bob");
  assert.notEqual(readFileSync(join(agent, "SYSTEM.md"), "utf8"), custom);
  assert.doesNotMatch(readFileSync(join(agent, "mem0-config.json"), "utf8"), /apiKey/);
  assert.throws(() => initializeHome(join(agent, "bad"), ""), /explicit stable/);
});
