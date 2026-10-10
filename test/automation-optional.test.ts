import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, run } from "./helpers/init-e2e-fixture.js";

const cli = new URL("../src/cli.js", import.meta.url);

test("core help and init do not expose or install optional Automation", async t => {
  const f = await fixture();
  t.after(() => f.close());
  const help = spawnSync(process.execPath, [cli.pathname, "--help"], { encoding: "utf8", env: f.env, cwd: f.project });
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /feishu automation/);
  const rejected = await run(f.project, f.env, ["automation", "list"]);
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /Unknown command/);
  const initialized = await run(f.project, f.env, ["init", "--model", "fake/fake-model"]);
  assert.equal(initialized.code, 0, initialized.stderr);
  assert.equal(existsSync(join(f.agentHome, "skills", "feishu-automation")), false);
  assert.equal(existsSync(join(f.home, "feishu-jobs")), false);
});
