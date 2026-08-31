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

test("Feishu loader keeps identity, allowed contexts, package prompts/themes, and private skill precedence isolated", async () => {
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
  const pkg = join(root, "package");
  mkdirSync(join(pkg, "prompts"), { recursive: true });
  mkdirSync(join(pkg, "themes"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "fixture-resources", version: "1.0.0", pi: { prompts: ["prompts"], themes: ["themes"] } }));
  writeFileSync(join(pkg, "prompts", "brief.md"), "---\nname: brief\ndescription: brief\n---\nWrite a brief.");
  writeFileSync(join(pkg, "themes", "fixture.json"), JSON.stringify({ name: "fixture", vars: { text: "#ffffff", bg: "#000000" }, colors: { accent: "text", border: "text", borderAccent: "text", borderMuted: "text", success: "text", error: "text", warning: "text", muted: "text", dim: "text", text: "text", thinkingText: "text", selectedBg: "bg", userMessageBg: "bg", userMessageText: "text", customMessageBg: "bg", customMessageText: "text", customMessageLabel: "text", toolPendingBg: "bg", toolSuccessBg: "bg", toolErrorBg: "bg", toolTitle: "text", toolOutput: "text", mdHeading: "text", mdLink: "text", mdLinkUrl: "text", mdCode: "text", mdCodeBlock: "text", mdCodeBlockBorder: "text", mdQuote: "text", mdQuoteBorder: "text", mdHr: "text", mdListBullet: "text", toolDiffAdded: "text", toolDiffRemoved: "text", toolDiffContext: "text", syntaxComment: "text", syntaxKeyword: "text", syntaxFunction: "text", syntaxVariable: "text", syntaxString: "text", syntaxNumber: "text", syntaxType: "text", syntaxOperator: "text", syntaxPunctuation: "text", thinkingOff: "text", thinkingMinimal: "text", thinkingLow: "text", thinkingMedium: "text", thinkingHigh: "text", thinkingXhigh: "text", bashMode: "text" } }));
  const { packageManager } = await import("../src/packages.js");
  await packageManager(home, project, "project").installAndPersist(pkg);

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
  assert.deepEqual(loader.getPrompts().prompts.map((entry) => entry.name), ["brief"]);
  assert.deepEqual(loader.getThemes().themes.map((entry) => entry.name), ["fixture"]);
});
