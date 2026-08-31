import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packageManager } from "../src/packages.js";

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
