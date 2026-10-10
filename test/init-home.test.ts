import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeHome } from "../src/init.js";

test("init creates an idempotent private Home without overwriting choices", () => {
  const agent = join(mkdtempSync(join(tmpdir(), "feishu-init-")), ".feishu-agent");
  initializeHome(agent);
  assert.equal(existsSync(join(agent, "mem0-config.json")), false);
  assert.match(readFileSync(join(agent, "SYSTEM.md"), "utf8"), /lark-cli skills read <name>/);
  const custom = "You are Feishu Agent. CUSTOM SYSTEM\n"; writeFileSync(join(agent, "SYSTEM.md"), custom);
  const settings = '{"defaultProvider":"fake","defaultModel":"one"}\n'; writeFileSync(join(agent, "settings.json"), settings);
  initializeHome(agent);
  assert.equal(readFileSync(join(agent, "SYSTEM.md"), "utf8"), custom);
  assert.equal(readFileSync(join(agent, "settings.json"), "utf8"), settings);
  initializeHome(agent, { system: true });
  assert.notEqual(readFileSync(join(agent, "SYSTEM.md"), "utf8"), custom);
  assert.match(readFileSync(join(agent, "SYSTEM.md"), "utf8"), /lark-cli skills read <name>/);
});

test("init installs default Feishu Skills without overwriting user edits", () => {
  const agent = join(mkdtempSync(join(tmpdir(), "feishu-init-skill-")), ".feishu-agent");
  const first = initializeHome(agent);
  const skillPath = join(agent, "skills", "feishu-skill-maker", "SKILL.md");
  assert(first.created.includes(skillPath));
  const body = readFileSync(skillPath, "utf8");
  assert.match(body, /^---\nname: feishu-skill-maker\n/m);
  assert.match(body, /项目私有 > 全局私有 > 安装包 > 官方缓存/);
  const finderPath = join(agent, "skills", "feishu-find-skill", "SKILL.md");
  assert(first.created.includes(finderPath));
  assert.match(readFileSync(finderPath, "utf8"), /~\/.feishu-agent\/skills/);
  for (const name of [
    "feishu-latex-rendering",
    "process-optimization-biweekly",
    "deslop-zh",
    "feishu-pro-diagram",
    "feishu-package-curator",
    "feishu-hermes-memory",
    "feishu-tech-note-writer",
    "volc-devinstance",
  ]) {
    const path = join(agent, "skills", name, "SKILL.md");
    assert(first.created.includes(path));
    assert.match(readFileSync(path, "utf8"), new RegExp(`^---\\nname: ${name}\\n`, "m"));
  }
  const refPath = join(agent, "skills", "feishu-tech-note-writer", "references", "evidence-check.md");
  assert(first.created.includes(refPath));
  assert.ok(existsSync(refPath));
  const devctlPath = join(agent, "skills", "volc-devinstance", "devctl");
  assert(first.created.includes(devctlPath));
  assert.ok(existsSync(devctlPath));
  const devctlBody = readFileSync(devctlPath, "utf8");
  assert.doesNotMatch(devctlBody, /\/home\/dministrator/);
  assert.match(devctlBody, /find_mlp_bin/);
  const hermesPaths = readFileSync(join(agent, "skills", "feishu-hermes-memory", "SKILL.md"), "utf8");
  assert.match(hermesPaths, /~\/\.feishu-agent\/pi-hermes-memory/);
  assert.match(hermesPaths, /PI_CODING_AGENT_DIR/);
  assert.match(hermesPaths, /不要按文档去 `~\/\.pi\/agent`/);
  const processTemplate = readFileSync(join(agent, "skills", "process-optimization-biweekly", "SKILL.md"), "utf8");
  assert.match(processTemplate, /<CHAT_ID>|<DOC_TOKEN>|<SPREADSHEET_TOKEN>/);
  assert.doesNotMatch(processTemplate, /(?:ou|oc)_[A-Za-z0-9]{12,}/);
  const edited = "---\nname: feishu-skill-maker\ndescription: 我的自定义规范\n---\n\n# Custom\n";
  writeFileSync(skillPath, edited);
  initializeHome(agent);
  assert.equal(readFileSync(skillPath, "utf8"), edited);
});
