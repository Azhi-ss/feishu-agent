import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeHome } from "../src/init.js";

test("fresh init requires identity but bare rerun reuses existing identity", () => {
  const agent = join(mkdtempSync(join(tmpdir(), "feishu-init-existing-")), ".feishu-agent");
  initializeHome(agent, "alice");
  assert.equal(initializeHome(agent, "ignored").identity, "feishu:alice");
});

test("init creates an idempotent private Home without overwriting choices", () => {
  const agent = join(mkdtempSync(join(tmpdir(), "feishu-init-")), ".feishu-agent");
  const first = initializeHome(agent, "alice");
  assert.equal(first.identity, "feishu:alice");
  const custom = "You are Feishu Agent. CUSTOM SYSTEM\n"; writeFileSync(join(agent, "SYSTEM.md"), custom);
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

test("init installs the default feishu-skill-maker without overwriting user edits", () => {
  const agent = join(mkdtempSync(join(tmpdir(), "feishu-init-skill-")), ".feishu-agent");
  const first = initializeHome(agent, "alice");
  const skillPath = join(agent, "skills", "feishu-skill-maker", "SKILL.md");
  assert(first.created.includes(skillPath));
  const body = readFileSync(skillPath, "utf8");
  assert.match(body, /^---\nname: feishu-skill-maker\n/m);
  assert.match(body, /项目私有 > 全局私有 > 安装包 > 官方缓存/);
  const edited = "---\nname: feishu-skill-maker\ndescription: 我的自定义规范\n---\n\n# Custom\n";
  writeFileSync(skillPath, edited);
  initializeHome(agent, "alice");
  assert.equal(readFileSync(skillPath, "utf8"), edited);
});
