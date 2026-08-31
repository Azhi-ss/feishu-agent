import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "dist/src/cli.js");
const home = mkdtempSync(join(tmpdir(), "feishu-surface-"));
mkdirSync(join(home, ".feishu-agent"), { recursive: true });

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, HOME: home, ...env } });
}

test("help exposes only the Feishu Agent surface and security boundary", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  for (const text of ["feishu -p", "feishu init", "feishu install", "feishu remove", "feishu list", "feishu update", "feishu config", "feishu skills sync", "-c", "-r", "--lark-profile"]) assert.match(result.stdout, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.stdout, /not an OS sandbox/i);
  assert.match(result.stdout, /current-user permissions/i);
});

test("unsupported modes and malformed commands fail without starting runtime", () => {
  for (const args of [["--mode", "json"], ["--mode", "rpc"], ["--json"], ["--rpc"], ["wat"], ["-p"]]) {
    const result = run(args);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr, /(not supported by Feishu Agent|unknown command|requires a prompt)/i);
  }
});

test("inspection forces telemetry off while preserving caller environment", () => {
  const result = run(["-p", "ignored"], { FEISHU_AGENT_INSPECT: "1", MEM0_TELEMETRY: "true", FEISHU_TEST_MARKER: "kept" });
  assert.equal(result.status, 0);
  const state = JSON.parse(result.stdout);
  assert.equal(state.mem0Telemetry, "false");
  assert.equal(state.home, home);
  assert.equal(state.environmentMarker, "kept");
});
