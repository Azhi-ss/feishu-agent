import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, linkSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { packageManager } from "../src/packages.js";
import { FeishuSettingsStorage } from "../src/settings.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function lockFixture() {
  const root = mkdtempSync(join(tmpdir(), "feishu-settings-lock-state-"));
  const agentHome = join(root, ".feishu-agent");
  const project = join(root, "project");
  mkdirSync(agentHome, { recursive: true });
  mkdirSync(project, { recursive: true });
  return { agentHome, project, settings: join(agentHome, "settings.json"), lock: join(agentHome, "settings.json.lock") };
}

function startLockAttempt(agentHome: string, project: string): { child: ReturnType<typeof spawn>; result: Promise<{ code: number | null; stderr: string }> } {
  const script = `import { FeishuSettingsStorage } from ${JSON.stringify(join(repoRoot, "dist/src/settings.js"))};\nnew FeishuSettingsStorage(process.argv[1], process.argv[2]).withLock("global", () => JSON.stringify({ acquired: true }));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, agentHome, project]);
  const result = new Promise<{ code: number | null; stderr: string }>((done) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("close", (code) => done({ code, stderr }));
  });
  return { child, result };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "feishu-packages-"));
  const agentHome = join(root, "home", ".feishu-agent");
  const project = join(root, "project");
  const pkg = join(root, "fixture-package");
  mkdirSync(agentHome, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(join(pkg, "skills", "fixture"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "fixture-package", version: "1.0.0", pi: { skills: ["skills"] } }));
  writeFileSync(join(pkg, "skills", "fixture", "SKILL.md"), "---\nname: fixture\ndescription: fixture\n---\n");
  return { root, agentHome, project, pkg };
}

test("settings lock preserves unrelated fields from two processes", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-settings-lock-"));
  const agentHome = join(root, ".feishu-agent");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const script = `import { FeishuSettingsStorage } from ${JSON.stringify(join(repoRoot, "dist/src/settings.js"))};\nconst [home, project, key, value, delay] = process.argv.slice(1);\nnew FeishuSettingsStorage(home, project).withLock("global", current => { const data = current ? JSON.parse(current) : {}; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(delay)); data[key] = value; return JSON.stringify(data); });`;
  const run = (key: string, value: string, delay: string) => new Promise<number | null>((done) => spawn(process.execPath, ["--input-type=module", "-e", script, agentHome, project, key, value, delay]).on("close", done));
  assert.deepEqual(await Promise.all([run("alpha", "one", "150"), run("beta", "two", "0")]), [0, 0]);
  assert.deepEqual(JSON.parse(readFileSync(join(agentHome, "settings.json"), "utf8")), { alpha: "one", beta: "two" });
});

test("settings lock never age-reaps a live owner", async () => {
  const f = lockFixture();
  writeFileSync(f.lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() - 86_400_000 }));
  const attempt = startLockAttempt(f.agentHome, f.project);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(attempt.child.exitCode, null);
  assert(existsSync(f.lock));
  assert.equal(statSync(f.settings, { throwIfNoEntry: false }), undefined);
  attempt.child.kill();
  await attempt.result;
});

test("settings lock grants an empty owner record publication grace", async () => {
  const f = lockFixture();
  writeFileSync(f.lock, "");
  const attempt = startLockAttempt(f.agentHome, f.project);
  await new Promise((resolve) => setTimeout(resolve, 200));
  writeFileSync(f.lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(attempt.child.exitCode, null);
  assert(existsSync(f.lock));
  assert.equal(statSync(f.settings, { throwIfNoEntry: false }), undefined);
  attempt.child.kill();
  await attempt.result;
});

test("settings lock recovers a dead stale owner", () => {
  const f = lockFixture();
  writeFileSync(f.lock, JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now() - 86_400_000 }));
  const old = new Date(Date.now() - 86_400_000);
  utimesSync(f.lock, old, old);
  new FeishuSettingsStorage(f.agentHome, f.project).withLock("global", () => JSON.stringify({ acquired: true }));
  assert.deepEqual(JSON.parse(readFileSync(f.settings, "utf8")), { acquired: true });
  assert(!existsSync(f.lock));
});

test("settings lock recovers a dead stale owner after an abandoned reaper claim", () => {
  const f = lockFixture();
  writeFileSync(f.lock, JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now() - 86_400_000 }));
  linkSync(f.lock, `${f.lock}.reap`);
  new FeishuSettingsStorage(f.agentHome, f.project).withLock("global", () => JSON.stringify({ acquired: true }));
  assert.deepEqual(JSON.parse(readFileSync(f.settings, "utf8")), { acquired: true });
  assert(!existsSync(f.lock));
  assert(existsSync(`${f.lock}.reap`));
});

test("package manager stores global and project package settings only in Feishu roots", async () => {
  const f = fixture();
  const manager = packageManager(f.agentHome, f.project, "project-key");
  await manager.installAndPersist(f.pkg);
  await manager.installAndPersist(f.pkg, { local: true });
  assert(existsSync(join(f.agentHome, "settings.json")));
  assert(existsSync(join(f.project, ".feishu-agent", "settings.json")));
  assert(!existsSync(join(f.project, ".pi")));
  assert.deepEqual(manager.listConfiguredPackages().map((entry) => entry.scope).sort(), ["project", "user"]);
  assert.match(readFileSync(join(f.project, ".feishu-agent", "settings.json"), "utf8"), /fixture-package/);
  assert(await manager.removeAndPersist(f.pkg, { local: true }));
});
