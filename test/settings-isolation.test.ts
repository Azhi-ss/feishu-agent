import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FeishuSettingsStorage, settingsManagerFor } from "../src/settings.js";

test("runtime settings read project .feishu-agent and never launch cwd .pi", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-settings-"));
  const agent = join(root, "home", ".feishu-agent");
  const project = join(root, "repo");
  const launch = join(project, "subdir");
  mkdirSync(agent, { recursive: true });
  mkdirSync(join(project, ".feishu-agent"), { recursive: true });
  mkdirSync(join(launch, ".pi"), { recursive: true });
  writeFileSync(join(agent, "settings.json"), '{"defaultProvider":"global","defaultModel":"one"}');
  writeFileSync(join(project, ".feishu-agent", "settings.json"), '{"defaultProvider":"project","defaultModel":"two"}');
  writeFileSync(join(launch, ".pi", "settings.json"), '{"defaultProvider":"foreign","defaultModel":"bad"}');
  const manager = settingsManagerFor(agent, project);
  assert.equal(manager.getDefaultProvider(), "project");
  manager.setProjectThemePaths(["themes/custom.json"]);
  await manager.flush();
  assert.match(readFileSync(join(project, ".feishu-agent", "settings.json"), "utf8"), /custom\.json/);
  assert.doesNotMatch(readFileSync(join(launch, ".pi", "settings.json"), "utf8"), /custom\.json/);
  const storage = new FeishuSettingsStorage(agent, project);
  assert.equal(storage.projectPath, join(project, ".feishu-agent", "settings.json"));
});

test("project settings stay empty when the project root is the Feishu Agent Home", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-settings-alias-"));
  const home = join(root, "home");
  const agent = join(home, ".feishu-agent");
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "one", packages: ["npm:@mem0/pi-agent-plugin@0.1.5"] }));
  const manager = settingsManagerFor(agent, home);
  assert.deepEqual(manager.getProjectSettings().packages ?? [], []);
  assert.equal(manager.getDefaultProvider(), "fake");
  const storage = new FeishuSettingsStorage(agent, home);
  assert.throws(() => storage.withLock("project", () => "{}"), /alias the global settings/);
  const before = readFileSync(join(agent, "settings.json"), "utf8");
  await manager.flush();
  assert.equal(readFileSync(join(agent, "settings.json"), "utf8"), before);
});
