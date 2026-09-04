import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { syncOfficialSkills } from "../src/official-skills.js";

function fake(root: string) {
  const bin = join(root, "bin");
  const log = join(root, "calls");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "lark-cli"), `#!/bin/sh\necho "$@" >> "${log}"\ncase "$*" in\n  "--version") echo "lark-cli 1.2.3";;\n  "skills list --json") echo '["docs"]';;\n  "skills read docs") echo '---\nname: docs\ndescription: official\n---\nbody';;\n  *) exit 2;;\nesac\n`, { mode: 0o755 });
  return { log, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } };
}

test("official Skill source is explicit for current, fallback, and unavailable caches", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-official-source-"));
  const cache = join(root, "cache");
  const f = fake(root);
  const current = await syncOfficialSkills(cache, false, f.env);
  assert.equal(current.source, "current");
  const brokenBin = join(root, "broken-bin");
  mkdirSync(brokenBin, { recursive: true });
  writeFileSync(join(brokenBin, "lark-cli"), '#!/bin/sh\n[ "$1" = --version ] && echo "lark-cli 2.0"\nexit 7\n', { mode: 0o755 });
  const fallback = await syncOfficialSkills(cache, false, { ...f.env, PATH: `${brokenBin}${delimiter}${process.env.PATH}` });
  assert.equal(fallback.source, "fallback");
  const noneRoot = mkdtempSync(join(tmpdir(), "feishu-official-none-"));
  const none = await syncOfficialSkills(join(noneRoot, "cache"), false, { ...f.env, PATH: `${brokenBin}${delimiter}${process.env.PATH}` });
  assert.equal(none.source, "none");
  assert.deepEqual(none.skills, []);
});

test("fallback selects the most recently published successful cache, not version text", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-official-fallback-"));
  const cache = join(root, "cache");
  mkdirSync(cache, { recursive: true });
  const publish = (version: string, mtime: Date) => {
    const dir = join(cache, Buffer.from(version).toString("base64url"));
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "SKILL.md"), `---\nname: docs\ndescription: ${version}\n---\nbody\n`);
    writeFileSync(join(dir, ".success"), version);
    utimesSync(join(dir, ".success"), mtime, mtime);
  };
  publish("lark-cli 1.10", new Date("2026-01-01T00:00:00Z"));
  publish("lark-cli 1.9", new Date("2026-02-01T00:00:00Z"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "lark-cli"), '#!/bin/sh\n[ "$1" = --version ] && { echo "lark-cli 2.0"; exit 0; }\nexit 7\n', { mode: 0o755 });
  const result = await syncOfficialSkills(cache, false, { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` });
  assert.equal(result.source, "fallback");
  assert.match(result.warning!, /using lark-cli 1\.9/);
  assert.equal(result.skills[0]?.description, "lark-cli 1.9");
});

test("official skill sync publishes atomically and reuses version cache", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-official-"));
  const cache = join(root, "cache");
  const f = fake(root);
  const first = await syncOfficialSkills(cache, false, f.env);
  assert.equal(first.source, "current");
  assert.equal(first.version, "lark-cli 1.2.3");
  assert.equal(first.skills.length, 1);
  assert.match(readFileSync(join(first.cacheDir, "docs", "SKILL.md"), "utf8"), /description: official/);
  const calls = readFileSync(f.log, "utf8");
  const second = await syncOfficialSkills(cache, false, f.env);
  assert.equal(second.cacheDir, first.cacheDir);
  assert.equal(readFileSync(f.log, "utf8"), calls + "--version\n");
  await syncOfficialSkills(cache, true, f.env);
  assert.match(readFileSync(f.log, "utf8"), /skills list --json[\s\S]*skills list --json/);
});

test("official skill sync accepts the real object-shaped skills list", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-official-object-"));
  const cache = join(root, "cache");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "lark-cli"), `#!/bin/sh
case "$*" in
  "--version") echo "lark-cli 1.0.92";;
  "skills list --json") echo '{"ok":true,"skills":[{"name":"lark-approval","description":"审批"},{"name":"lark-im","description":"消息"}]}'
;;
  "skills read lark-approval") echo '---\nname: lark-approval\ndescription: approval\n---\nbody';;
  "skills read lark-im") echo '---\nname: lark-im\ndescription: im\n---\nbody';;
  *) exit 2;;
esac
`, { mode: 0o755 });
  const result = await syncOfficialSkills(cache, false, { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` });
  assert.equal(result.skills.length, 2);
  assert.deepEqual(result.skills.map((skill) => skill.name).sort(), ["lark-approval", "lark-im"]);
});

test("cache-only startup never calls skills list or skills read when cache is absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-official-cache-only-"));
  const cache = join(root, "cache");
  const f = fake(root);
  const result = await syncOfficialSkills(cache, false, f.env, { allowSync: false });
  assert.equal(result.source, "none");
  const calls = readFileSync(f.log, "utf8");
  assert.equal(calls, "--version\n");
  assert.doesNotMatch(calls, /skills list|skills read/);
});
