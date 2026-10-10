import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { REMOTE_PACKAGE_SOURCE, REMOTE_PACKAGE_VERSION, feishuRemotePackagePath } from "../src/remote-package.js";
import {
  run,
  lines,
  allFiles,
  fixture,
  configuredPackages,
  assertPinnedRemotePackageInstalled,
  isRemoteSource,
  installs,
  assertCompleteSummary,
} from "./helpers/init-e2e-fixture.js";

test("the pinned Remote Package source matches the publishable workspace version", () => {
  const manifest = JSON.parse(readFileSync(join(feishuRemotePackagePath(), "package.json"), "utf8")) as { name?: string; version?: string };
  assert.equal(manifest.name, "@azhi-ss/feishu-remote");
  assert.equal(manifest.version, REMOTE_PACKAGE_VERSION);
  assert.equal(REMOTE_PACKAGE_SOURCE, `npm:${manifest.name}@${manifest.version}`);
});


test("fresh HOME one-command init is immediately Print-ready, idempotent, isolated, reset-explicit, and secret-free", async () => {
  const f = await fixture();
  try {
    assert.equal(existsSync(f.agentHome), false);
    const first = await run(f.project, f.env, ["init", "--model", "fake/fake-model", "--thinking", "medium"]);
    assert.equal(first.code, 0, first.stderr);
    assertCompleteSummary(first.stdout, f.agentHome, "fake-model");
    assert.doesNotMatch(first.stdout + first.stderr, new RegExp(f.secret));
    assert.equal(configuredPackages(f.agentHome).filter((entry) => entry.includes("@mem0/")).length, 0);
    assertPinnedRemotePackageInstalled(f.agentHome);
    assert(lines(f.npmLog).every((line) => line.startsWith("|")));
    assert(lines(f.larkLog).every((line) => line.startsWith("|")));

    const printed = await run(f.project, f.env, ["-p", "ping"]);
    assert.equal(printed.code, 0, printed.stderr);
    assert.match(printed.stdout, /pong/);
    const modelRequest = f.modelRequests.at(-1);
    assert.equal(modelRequest.model, "fake-model");
    assert.match(JSON.stringify(modelRequest), /OFFICIAL_SKILL_SENTINEL/);
    assert.match(JSON.stringify(modelRequest), /feishu-hermes-memory/);
    assert.match(readFileSync(join(f.agentHome, "skills", "feishu-hermes-memory", "SKILL.md"), "utf8"), /~\/\.feishu-agent\/pi-hermes-memory/);
    assert.equal(f.memoryRequests.length, 0);

    const bareRerun = await run(f.project, f.env, ["init"]);
    assert.equal(bareRerun.code, 0, bareRerun.stderr);
    assertCompleteSummary(bareRerun.stdout, f.agentHome, "fake-model");

    for (const name of ["SOUL.md", "USER.md"]) {
      assert.equal(existsSync(join(f.agentHome, name)), false);
      writeFileSync(join(f.agentHome, name), `CUSTOM-${name}\n`);
    }
    const customSystem = "You are Feishu Agent. CUSTOM FEISHU IDENTITY\n";
    writeFileSync(join(f.agentHome, "SYSTEM.md"), customSystem);
    writeFileSync(join(f.agentHome, "custom.txt"), "keep me\n");
    const rerun = await run(f.project, f.env, ["init", "--model", "fake/other-model", "--thinking", "high"]);
    assert.equal(rerun.code, 0, rerun.stderr);
    assertCompleteSummary(rerun.stdout, f.agentHome, "fake-model");
    const settings = JSON.parse(readFileSync(join(f.agentHome, "settings.json"), "utf8"));
    assert.deepEqual([settings.defaultProvider, settings.defaultModel, settings.defaultThinkingLevel], ["fake", "fake-model", "medium"]);
    assert.equal(readFileSync(join(f.agentHome, "SYSTEM.md"), "utf8"), customSystem);
    for (const name of ["SOUL.md", "USER.md"]) assert.equal(readFileSync(join(f.agentHome, name), "utf8"), `CUSTOM-${name}\n`);
    assert.equal(existsSync(join(f.agentHome, "mem0-config.json")), false);
    assert.equal(readFileSync(join(f.agentHome, "custom.txt"), "utf8"), "keep me\n");
    assert.equal(lines(f.npmLog).length, 1, "the Remote package must not be installed twice");
    assert.equal(lines(f.npmLog).some((line) => line.includes("@mem0/")), false);
    assert.equal(lines(f.larkLog).filter((line) => line.endsWith("|skills list --json")).length, 1, "valid Skill cache must be reused");

    const reset = await run(f.project, f.env, ["init", "--model", "fake/other-model", "--thinking", "high", "--reset-model", "--reset-system"]);
    assert.equal(reset.code, 0, reset.stderr);
    assertCompleteSummary(reset.stdout, f.agentHome, "other-model");
    assert.notEqual(readFileSync(join(f.agentHome, "SYSTEM.md"), "utf8"), customSystem);
    for (const name of ["SOUL.md", "USER.md"]) assert.equal(readFileSync(join(f.agentHome, name), "utf8"), `CUSTOM-${name}\n`);
    assert.equal(existsSync(join(f.agentHome, "mem0-config.json")), false);
    assert.equal(readFileSync(join(f.agentHome, "custom.txt"), "utf8"), "keep me\n");
    assert.equal(existsSync(join(f.project, ".pi")), false);
    for (const path of allFiles(f.agentHome)) assert.doesNotMatch(readFileSync(path).toString(), new RegExp(f.secret), path);
    assert.doesNotMatch(first.stdout + first.stderr + printed.stdout + printed.stderr + rerun.stdout + rerun.stderr + reset.stdout + reset.stderr, new RegExp(f.secret));
  } finally { f.close(); }
});

test("official Skill sync failure continues with a successful prior cache warning", async () => {
  const f = await fixture();
  try {
    f.setLarkVersion("lark-cli 9.9.8");
    const cached = await run(f.project, f.env, ["init", "--model", "fake/fake-model"]);
    assert.equal(cached.code, 0, cached.stderr);

    f.setLarkVersion("lark-cli 9.9.9");
    f.failSkills();
    const fallback = await run(f.project, f.env, ["init", "--model", "fake/fake-model"]);
    assert.equal(fallback.code, 0, fallback.stderr);
    assertCompleteSummary(fallback.stdout, f.agentHome, "fake-model");
    assert.match(fallback.stderr, /Startup Warning: Official Skills for lark-cli 9\.9\.9 unavailable; using lark-cli 9\.9\.8\./);
    assert.equal(lines(f.larkLog).filter((line) => line.endsWith("|skills list --json")).length, 2);
  } finally { f.close(); }
});

test("init keeps an existing npm Feishu Remote Package source", async () => {
  const f = await fixture();
  try {
    mkdirSync(f.agentHome, { recursive: true });
    writeFileSync(join(f.agentHome, "settings.json"), JSON.stringify({ packages: ["npm:@azhi-ss/feishu-remote"] }));
    const result = await run(f.project, f.env, ["init", "--model", "fake/fake-model"]);
    assert.equal(result.code, 0, result.stderr);
    assert(configuredPackages(f.agentHome).includes("npm:@azhi-ss/feishu-remote"));
    assert.equal(configuredPackages(f.agentHome).filter((entry) => typeof entry === "string" && entry.includes("packages/feishu-remote")).length, 0);
  } finally { f.close(); }
});

test("init keeps an existing local Feishu Remote Package source", async () => {
  const f = await fixture();
  try {
    mkdirSync(f.agentHome, { recursive: true });
    writeFileSync(join(f.agentHome, "settings.json"), JSON.stringify({ packages: [feishuRemotePackagePath()] }));
    const result = await run(f.project, f.env, ["init", "--model", "fake/fake-model"]);
    assert.equal(result.code, 0, result.stderr);
    assert(configuredPackages(f.agentHome).includes(feishuRemotePackagePath()));
    assert.equal(configuredPackages(f.agentHome).filter((entry) => typeof entry === "string" && isRemoteSource(entry)).length, 0);
    assert.equal(installs(f.npmLog).length, 0, "init installs nothing when a local Remote Package already exists");
  } finally { f.close(); }
});

test("init leaves an existing Mem0 package entry alone", async () => {
  const f = await fixture();
  try {
    mkdirSync(f.agentHome, { recursive: true });
    writeFileSync(join(f.agentHome, "settings.json"), JSON.stringify({ packages: ["npm:@mem0/pi-agent-plugin@0.1.4", "npm:@mem0/pi-agent-plugin-extra"] }));
    const result = await run(f.project, f.env, ["init", "--model", "fake/fake-model"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(configuredPackages(f.agentHome).filter((entry) => entry.includes("@mem0/")), ["npm:@mem0/pi-agent-plugin@0.1.4", "npm:@mem0/pi-agent-plugin-extra"]);
    assert.equal(installs(f.npmLog).filter((line) => line.includes("@mem0/")).length, 0);
    assertPinnedRemotePackageInstalled(f.agentHome);
  } finally { f.close(); }
});
