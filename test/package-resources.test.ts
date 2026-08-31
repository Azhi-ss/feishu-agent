import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packageManager } from "../src/packages.js";

function resource(root: string, dir: string, file: string, body: string) {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, file), body);
}

function fixture(manifest = true) {
  const root = mkdtempSync(join(tmpdir(), "feishu-package-resources-"));
  const agentHome = join(root, "home", ".feishu-agent");
  const project = join(root, "project");
  const pkg = join(root, "pkg");
  mkdirSync(agentHome, { recursive: true }); mkdirSync(project, { recursive: true }); mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "fixture-all", version: "1.0.0", ...(manifest ? { pi: { extensions: ["extensions"], skills: ["skills"], prompts: ["prompts"], themes: ["themes"] } } : {}) }));
  resource(pkg, "extensions", "one.js", "export default () => {}\n");
  resource(pkg, "extensions", "legacy.js", "export default () => {}\n");
  resource(pkg, "skills/one", "SKILL.md", "---\nname: one\ndescription: one\n---\n");
  resource(pkg, "prompts", "one.md", "---\nname: one\ndescription: one\n---\nbody\n");
  resource(pkg, "themes", "one.json", '{}\n');
  return { root, agentHome, project, pkg };
}

function names(resolved: Awaited<ReturnType<ReturnType<typeof packageManager>["resolve"]>>, pkg: string) {
  return Object.fromEntries(Object.entries(resolved).map(([type, entries]) => [type, (entries as Array<{ enabled: boolean; path: string }>).filter((entry) => entry.enabled && entry.path.startsWith(pkg)).map((entry) => entry.path)]));
}

test("Pi package semantics load manifest and conventional resources, filters, and deduplication in Feishu storage", async () => {
  for (const manifest of [true, false]) {
    const f = fixture(manifest); const manager = packageManager(f.agentHome, f.project, "key");
    await manager.installAndPersist(f.pkg);
    const all = names(await manager.resolve(), f.pkg);
    assert.equal(all.extensions.length, 2); assert.equal(all.skills.length, 1); assert.equal(all.prompts.length, 1); assert.equal(all.themes.length, 1);
  }

  const f = fixture();
  writeFileSync(join(f.agentHome, "settings.json"), JSON.stringify({ packages: [{ source: f.pkg, skills: [], extensions: ["extensions/*.js", "!extensions/legacy.js", "+extensions/legacy.js", "-extensions/one.js"] }] }));
  const filtered = names(await packageManager(f.agentHome, f.project, "key").resolve(), f.pkg);
  assert.deepEqual(filtered.skills, []);
  assert.equal(filtered.extensions.length, 1);
  assert.match(filtered.extensions[0], /legacy\.js$/);
  assert.equal(filtered.prompts.length, 1);
  assert.equal(filtered.themes.length, 1);

  const manager = packageManager(f.agentHome, f.project, "key");
  await manager.installAndPersist(f.pkg, { local: true });
  const deduped = await manager.resolve();
  assert(deduped.extensions.filter((entry) => entry.path.startsWith(f.pkg)).every((entry) => entry.metadata.scope === "project"));
});
