import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withCompatibilityHome } from "../src/compatibility-home.js";

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
