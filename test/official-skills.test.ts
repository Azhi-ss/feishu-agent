import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { syncOfficialSkills, updateLarkCliAtStartup } from "../src/official-skills.js";

function fake(root: string) {
  const bin = join(root, "bin");
  const log = join(root, "calls");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "lark-cli"), `#!/bin/sh\necho "$@" >> "${log}"\ncase "$*" in\n  "--version") echo "lark-cli 1.2.3";;\n  "skills list --json") echo '["docs"]';;\n  "skills read docs") echo '---\nname: docs\ndescription: official\n---\nbody';;\n  *) exit 2;;\nesac\n`, { mode: 0o755 });
  return { log, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } };
}

test("startup update installs an available CLI release before official Skill export", () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-lark-update-"));
  const cache = join(root, "cache");
  const bin = join(root, "bin");
  const version = join(root, "version");
  const log = join(root, "calls");
  mkdirSync(bin, { recursive: true });
  writeFileSync(version, "1.0.0");
  writeFileSync(join(bin, "lark-cli"), `#!/bin/sh
set -eu
echo "$@" >> ${JSON.stringify(log)}
case "$*" in
  "update --json") printf '2.0.0' > ${JSON.stringify(version)}; echo '{"ok":true,"action":"updated"}';;
  "--version") printf 'lark-cli '; cat ${JSON.stringify(version)};;
  "skills list --json") echo '["docs"]';;
  "skills read docs") printf -- '---\nname: docs\ndescription: updated\n---\nbody\n';;
  *) exit 2;;
esac
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
  assert.equal(updateLarkCliAtStartup(env), undefined);
  const result = syncOfficialSkills(cache, false, env);
  assert.equal(result.version, "lark-cli 2.0.0");
  assert.equal(result.skills[0]?.description, "updated");
  assert.match(readFileSync(log, "utf8"), /^update --json\n--version\nskills list --json\nskills read docs\n$/);
});

test("startup update failure is non-blocking and offline mode skips the check", () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-lark-update-failure-"));
  const bin = join(root, "bin");
  const log = join(root, "calls");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "lark-cli"), `#!/bin/sh
echo "$@" >> ${JSON.stringify(log)}
echo offline >&2
exit 7
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
  assert.match(updateLarkCliAtStartup(env)!, /update check failed; continuing/);
  assert.equal(updateLarkCliAtStartup({ ...env, PI_OFFLINE: "1" }), undefined);
  assert.equal(readFileSync(log, "utf8"), "update --json\n");
});

test("startup update reports manual installation without blocking", () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-lark-update-manual-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "lark-cli"), `#!/bin/sh
echo '{"ok":true,"action":"manual_required","message":"manual install required","url":"https://example.test/release"}'
`, { mode: 0o755 });
  const warning = updateLarkCliAtStartup({ ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` });
  assert.match(warning!, /manual install required.*https:\/\/example\.test\/release/);
});
test("fallback selects the most recently published successful cache, not version text", () => {
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
  const result = syncOfficialSkills(cache, false, { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` });
  assert.match(result.warning!, /using lark-cli 1\.9/);
  assert.equal(result.skills[0]?.description, "lark-cli 1.9");
});

test("official skill sync publishes atomically and reuses version cache", () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-official-"));
  const cache = join(root, "cache");
  const f = fake(root);
  const first = syncOfficialSkills(cache, false, f.env);
  assert.equal(first.version, "lark-cli 1.2.3");
  assert.equal(first.skills.length, 1);
  assert.match(readFileSync(join(first.cacheDir, "docs", "SKILL.md"), "utf8"), /description: official/);
  const calls = readFileSync(f.log, "utf8");
  const second = syncOfficialSkills(cache, false, f.env);
  assert.equal(second.cacheDir, first.cacheDir);
  assert.equal(readFileSync(f.log, "utf8"), calls + "--version\n");
  syncOfficialSkills(cache, true, f.env);
  assert.match(readFileSync(f.log, "utf8"), /skills list --json[\s\S]*skills list --json/);
});

test("official skill sync accepts the real object-shaped skills list", () => {
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
  const result = syncOfficialSkills(cache, false, { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` });
  assert.equal(result.skills.length, 2);
  assert.deepEqual(result.skills.map((skill) => skill.name).sort(), ["lark-approval", "lark-im"]);
});
