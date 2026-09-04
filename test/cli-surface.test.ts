import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "dist/src/cli.js");
const home = mkdtempSync(join(tmpdir(), "feishu-surface-"));
mkdirSync(join(home, ".feishu-agent"), { recursive: true });

function run(args: string[], env: Record<string, string> = {}, overrideHome = home) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, HOME: overrideHome, ...env } });
}

function snapshot(root: string): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  const walk = (directory: string, prefix = "") => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const relative = join(prefix, name);
      if (statSync(path).isDirectory()) walk(path, relative);
      else result.set(relative, readFileSync(path));
    }
  };
  walk(root);
  return result;
}

test("help exposes only the Feishu Agent surface and security boundary", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  for (const text of ["feishu -p", "feishu init", "feishu install", "feishu remove", "feishu list", "feishu update", "feishu config", "feishu skills sync", "/find-skill", "-c", "-r", "--session", "--lark-profile"]) assert.match(result.stdout, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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

test("exact command parsing rejects every malformed command surface before inspection or mutation", () => {
  const invalid = [
    ["-p", "ping", "extra"], ["-p", "ping", "--model", "fake/x"], ["-c", "extra"], ["-r", "--foo"], ["--session"], ["--session", "--foo"], ["--session", "id", "extra"],
    ["list", "extra"], ["install"], ["install", "pkg", "extra"], ["install", "--foo", "pkg"], ["remove", "pkg", "--local"],
    ["update", "a", "b"], ["update", "--extensions", "extra"], ["skills"], ["skills", "sync", "extra"],
    ["config", "set", "pkg", "skills"], ["config", "set", "--model", "skills", "on"], ["config", "--foo"],
    ["init", "--identity", "--model", "fake/x"], ["init", "--model"], ["init", "--thinking", "--reset-model"],
    ["--lark-profile", "--help", "list"], ["--foo"],
  ];
  for (const args of invalid) {
    const result = run(args, { FEISHU_AGENT_INSPECT: "1" });
    assert.notEqual(result.status, 0, args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
  }
});

test("init validates every value-bearing option, including thinking enum, before filesystem mutation", () => {
  const freshHome = mkdtempSync(join(tmpdir(), "feishu-invalid-thinking-fresh-"));
  const fresh = run(["init", "--identity", "alice", "--model", "fake/model", "--thinking", "bogus"], {}, freshHome);
  assert.notEqual(fresh.status, 0);
  assert.match(fresh.stderr, /--thinking must be one of off, minimal, low, medium, high, xhigh/);
  assert.equal(statSync(join(freshHome, ".feishu-agent"), { throwIfNoEntry: false }), undefined);

  const existingHome = mkdtempSync(join(tmpdir(), "feishu-invalid-thinking-existing-"));
  const agentHome = join(existingHome, ".feishu-agent");
  mkdirSync(join(agentHome, "nested"), { recursive: true });
  writeFileSync(join(agentHome, "SYSTEM.md"), "You are Feishu Agent. custom\n");
  writeFileSync(join(agentHome, "settings.json"), '{"defaultProvider":"fake","defaultModel":"model"}\n');
  writeFileSync(join(agentHome, "nested", "state.bin"), Buffer.from([0, 1, 2, 255]));
  const before = snapshot(agentHome);
  const existing = run(["init", "--identity", "alice", "--model", "fake/model", "--thinking", "bogus"], {}, existingHome);
  assert.notEqual(existing.status, 0);
  assert.match(existing.stderr, /--thinking must be one of off, minimal, low, medium, high, xhigh/);
  assert.deepEqual(snapshot(agentHome), before);

  for (const args of [
    ["init", "--identity", " "],
    ["init", "--model", "not-a-provider-model"],
    ["init", "--thinking", "--reset-model"],
    ["--lark-profile", "--help"],
  ]) {
    const optionHome = mkdtempSync(join(tmpdir(), "feishu-invalid-value-"));
    assert.notEqual(run(args, {}, optionHome).status, 0, args.join(" "));
    assert.equal(statSync(join(optionHome, ".feishu-agent"), { throwIfNoEntry: false }), undefined, args.join(" "));
  }
});

test("inspection forces telemetry off while preserving caller environment", () => {
  const result = run(["-p", "ignored"], { FEISHU_AGENT_INSPECT: "1", MEM0_TELEMETRY: "true", FEISHU_TEST_MARKER: "kept" });
  assert.equal(result.status, 0);
  const state = JSON.parse(result.stdout);
  assert.equal(state.mem0Telemetry, "false");
  assert.equal(state.home, home);
  assert.equal(state.piCodingAgentDir, join(home, ".feishu-agent"));
  assert.equal(state.environmentMarker, "kept");
});
