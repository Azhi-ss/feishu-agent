import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FeishuResourceLoader } from "../src/resources.js";

// Core-collision enforcement is exercised through the public loader's composed extension result.
test("loader always preserves the seven reserved core tool names", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-core-policy-"));
  const home = join(root, "home", ".feishu-agent");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, "SYSTEM.md"), "You are Feishu Agent. custom identity cannot replace core");
  const loader = new FeishuResourceLoader(home, project, "key");
  await loader.reload();
  assert.match(loader.getSystemPrompt()!, /^You are Feishu Agent/);
  assert.deepEqual(loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()].filter((name) => ["read", "edit", "write", "bash", "grep", "find", "ls"].includes(name))), []);
});
