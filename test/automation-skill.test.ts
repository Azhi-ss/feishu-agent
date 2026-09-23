import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, run, allFiles } from "./helpers/init-e2e-fixture.js";
import { repoRoot } from "./helpers/automation-cli-fixture.js";

// A real local package install exercises the normal resource loader, not a
// manually copied Skill or assertions on loader internals.
test("Automation is opt-in, discoverable after package install and absent after removal", async t => {
  const f = await fixture();
  t.after(() => f.close());
  const source = join(repoRoot, "packages/feishu-automation");
  const init = await run(f.project, f.env, ["init", "--identity", "alice", "--model", "fake/fake-model"]);
  assert.equal(init.code, 0, init.stderr);
  assert.equal(existsSync(join(f.agentHome, "skills/feishu-automation")), false);
  const before = await run(f.project, f.env, ["-p", "ping"]);
  assert.equal(before.code, 0, before.stderr);
  assert.doesNotMatch(JSON.stringify(f.modelRequests.at(-1)), /name="feishu-automation"|<name>feishu-automation<\/name>/);
  const installed = await run(f.project, f.env, ["install", source]);
  assert.equal(installed.code, 0, installed.stderr);
  const printed = await run(f.project, f.env, ["-p", "How do I schedule a Feishu task?"]);
  assert.equal(printed.code, 0, printed.stderr);
  assert.match(JSON.stringify(f.modelRequests.at(-1)), /feishu-automation[\s\S]*SKILL.md/);
  assert.equal(existsSync(join(f.home, "feishu-jobs")), false);
  const removed = await run(f.project, f.env, ["remove", source]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal((await run(f.project, f.env, ["-p", "ping"])).code, 0);
  assert.doesNotMatch(JSON.stringify(f.modelRequests.at(-1)), /<name>feishu-automation<\/name>/);
  for (const root of [join(f.home, ".agents"), join(f.pi, "skills"), join(f.project, ".pi")]) assert.equal(existsSync(root), false);
  for (const path of allFiles(f.agentHome)) assert(!readFileSync(path, "utf8").includes(f.secret), path);
});
