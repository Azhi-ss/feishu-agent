import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { baseEnv, fixture, repoRoot, textResponse } from "./helpers/automation-cli-fixture.js";

// The packed artifact must work outside the checkout without node_modules or
// imports into core src. All business execution still uses the fake HOME/model.
test("packed optional package runs via public Feishu CLI without runtime npm dependencies", { timeout: 30_000 }, async t => {
  const f = await fixture();
  t.after(() => { f.model.server.closeAllConnections(); f.model.server.close(); rmSync(f.root, { recursive: true, force: true }); });
  const dest = join(f.root, "unpacked package");
  mkdirSync(dest);
  const packed = JSON.parse(execFileSync("npm", ["pack", "--workspace", "@azhi-ss/feishu-automation", "--ignore-scripts", "--json", "--pack-destination", f.root], { cwd: repoRoot, encoding: "utf8" }))[0];
  assert(packed.files.some((file: { path: string }) => file.path === "dist/worker.js"));
  assert(packed.files.some((file: { path: string }) => file.path === "skills/feishu-automation/SKILL.md"));
  assert(!packed.files.some((file: { path: string }) => file.path.startsWith("src/") || file.path.includes("node_modules")));
  execFileSync("tar", ["-xzf", join(f.root, packed.filename), "-C", dest]);
  const cli = join(dest, "package/dist/cli.js");
  const env = baseEnv(f);
  const added = spawnSync(process.execPath, [cli, "add", "--name", "packed", "--at", "2030-06-01T09:00", "--prompt-stdin", "--yes"], { cwd: f.root, env, input: "Reply PACKED-FEISHU-RESULT.", encoding: "utf8" });
  assert.equal(added.status, 0, added.stderr);
  f.model.responses.push(textResponse("PACKED-FEISHU-RESULT"));
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "run", "packed"], { cwd: f.root, env });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => stdout += data);
    child.stderr.on("data", data => stderr += data);
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).outcome, "completed");
  assert.equal(f.model.requests.length, 1);
  assert.equal(existsSync(join(dest, "package/node_modules")), false);
});
