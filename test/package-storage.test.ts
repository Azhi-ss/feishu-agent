import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { packageManager } from "../src/packages.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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
