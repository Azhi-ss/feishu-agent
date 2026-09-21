import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withCompatibilityHome } from "../src/compatibility-home.js";
import { baseEnv, cli, fixture, gate, textResponse } from "./helpers/automation-trigger-fixture.js";

// Publish a competing mapping at the filesystem boundary after the CLI's
// existence check. This pins the first-start race without timing-based retries.
for (const competing of ["same-target", "wrong-target", "directory"] as const) {
  test(`Print handles a concurrent Compatibility Home mapping: ${competing}`, { timeout: 30_000 }, async (t) => {
    const f = await fixture();
    t.after(() => { f.model.server.closeAllConnections(); f.model.server.close(); });
    f.model.jobs.push(gate(textResponse("COMPAT-RACE-DONE")));
    const target = join(f.home, ".feishu-agent");
    const link = join(target, ".compat", "home", ".pi", "agent");
    const preload = join(f.root, "competing-home.cjs");
    const published = join(f.root, "published");
    writeFileSync(preload, `
const fs = require("node:fs");
const original = fs.symlinkSync;
fs.symlinkSync = function(target, path, type) {
  if (path === ${JSON.stringify(link)}) {
    ${competing === "directory" ? "fs.mkdirSync(path);" : `original(${competing === "same-target" ? "target" : JSON.stringify(f.root)}, path, type);`}
    fs.writeFileSync(${JSON.stringify(published)}, "published");
  }
  return original(target, path, type);
};
require("node:module").syncBuiltinESMExports();
`);
    const child = spawn(process.execPath, ["--require", preload, cli, "-p", "Reply COMPAT-RACE-DONE"], {
      cwd: f.root, env: baseEnv(f, { FEISHU_UNATTENDED: "1" }), stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert(existsSync(published), "the real Print CLI must reach the competing publication");
    if (competing === "same-target") {
      assert.equal(code, 0, stderr);
      assert.match(stdout, /COMPAT-RACE-DONE/);
      assert.equal(f.model.requests.length, 1);
      assert.equal(readlinkSync(link), target);
    } else {
      assert.notEqual(code, 0, "an incompatible mapping must fail closed");
      assert.match(stderr, /Invalid compatibility Home mapping/);
      assert.equal(f.model.requests.length, 0);
      if (competing === "wrong-target") assert.equal(readlinkSync(link), f.root);
    }
    assert(!existsSync(join(f.root, ".pi")), "never create ordinary Pi project storage");
  });
}

test("Compatibility Home is temporary and restored after success or failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-compat-"));
  const real = join(root, "real"); const agent = join(root, "real", ".feishu-agent");
  const previous = process.env.HOME; process.env.HOME = real;
  try {
    await withCompatibilityHome(real, agent, async () => assert.match(process.env.HOME!, /\.feishu-agent\/\.compat\/home$/));
    assert.equal(process.env.HOME, real);
    await assert.rejects(withCompatibilityHome(real, agent, async () => { throw new Error("boom"); }), /boom/);
    assert.equal(process.env.HOME, real);
  } finally { process.env.HOME = previous; }
});
