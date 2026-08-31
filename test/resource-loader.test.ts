import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FeishuResourceLoader } from "../src/resources.js";

function skill(path: string, name: string, description: string) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
}

test("Feishu loader keeps identity, allowed contexts, and private skill precedence isolated", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-resources-"));
  const home = join(root, "home", ".feishu-agent");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(project, ".feishu-agent"), { recursive: true });
  writeFileSync(join(home, "SYSTEM.md"), "CUSTOM FEISHU BASE");
  writeFileSync(join(project, ".feishu-agent", "AGENTS.md"), "FEISHU PROJECT RULE");
  writeFileSync(join(project, "AGENTS.md"), "ROOT RULE");
  skill(join(home, "skills", "shared"), "shared", "global");
  skill(join(project, ".feishu-agent", "skills", "shared"), "shared", "project");
  skill(join(root, "home", ".pi", "agent", "skills", "foreign"), "foreign", "no");
  skill(join(project, ".agents", "skills", "also-foreign"), "also-foreign", "no");

  const loader = new FeishuResourceLoader(home, project);
  await loader.reload();
  assert.match(loader.getSystemPrompt()!, /You are Feishu Agent/);
  assert.match(loader.getSystemPrompt()!, /Feishu Runtime.*Feishu Project/s);
  assert.match(loader.getSystemPrompt()!, /Long-term Memory.*Lark Identity.*High-risk Approval/s);
  assert.match(loader.getSystemPrompt()!, /CUSTOM FEISHU BASE.*FEISHU PROJECT RULE.*ROOT RULE/s);
  assert.match(loader.getSystemPrompt()!, /ordinary pi/);
  assert.match(loader.getSystemPrompt()!, /not filesystem isolation|not an OS sandbox/);
  assert.deepEqual(loader.getSkills().skills.map((entry) => [entry.name, entry.description]), [["shared", "project"]]);
  assert.match(loader.warnings.join("\n"), /selected .*project.*shadowed .*home/s);
  assert.deepEqual(loader.getAgentsFiles().agentsFiles.map((entry) => entry.path), [join(project, ".feishu-agent", "AGENTS.md"), join(project, "AGENTS.md")]);
});
