import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "dist/src/cli.js");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "feishu-skills-update-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".feishu-agent"), { recursive: true });
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(root, "calls");
  const updated = join(root, "updated");
  writeFileSync(join(bin, "lark-cli"), `#!/bin/sh
echo "$@" >> "${log}"
case "$*" in
  "update --json") touch "${updated}"; echo '{"ok":true,"version":"1.0.94"}';;
  "--version") [ -f "${updated}" ] && echo "lark-cli 1.0.94" || echo "lark-cli 1.0.0";;
  "skills list --json") echo '["docs"]';;
  "skills read docs") echo '---
name: docs
description: official
---
body';;
  *) echo "unexpected: $*" >&2; exit 2;;
esac
`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}` };
  return { root, home, log, env, cacheFor: (version: string) => join(home, ".feishu-agent", "official-skills", Buffer.from(version).toString("base64url")) };
}

function run(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env });
}

test("plain skills sync rebuilds the cache without invoking lark-cli update", () => {
  const f = setup();
  const result = run(["skills", "sync"], f.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Synchronized official Skills for lark-cli 1\.0\.0/);
  const calls = readFileSync(f.log, "utf8");
  assert.doesNotMatch(calls, /update/);
  assert.ok(existsSync(join(f.cacheFor("lark-cli 1.0.0"), ".success")));
});

test("skills sync --update updates lark-cli first, then exports the new version's skills", () => {
  const f = setup();
  const result = run(["skills", "sync", "--update"], f.env);
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(f.log, "utf8").trim().split("\n");
  assert.equal(calls[0], "update --json", "lark-cli update must run before version/skill export");
  assert.match(result.stdout, /Synchronized official Skills for lark-cli 1\.0\.94/);
  assert.ok(existsSync(join(f.cacheFor("lark-cli 1.0.94"), "docs", "SKILL.md")));
});

test("skills sync rejects unknown flags and extra positionals", () => {
  for (const args of [["skills", "sync", "--bogus"], ["skills", "sync", "--update", "x"], ["skills", "sync", "extra"]]) {
    const f = setup();
    const result = run(args, f.env);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr, /skills sync/, args.join(" "));
    assert.ok(!existsSync(f.log) || !readFileSync(f.log, "utf8").includes("skills list"));
  }
});

test("a failed lark-cli update exits non-zero and leaves the cache untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-skills-update-fail-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".feishu-agent"), { recursive: true });
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(root, "calls");
  writeFileSync(join(bin, "lark-cli"), `#!/bin/sh
echo "$@" >> "${log}"
case "$*" in
  "update --json") echo 'update boom' >&2; exit 1;;
  *) exit 2;;
esac
`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}` };
  const result = run(["skills", "sync", "--update"], env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /lark-cli update/i);
  assert.equal(readFileSync(log, "utf8").trim(), "update --json");
  assert.ok(!existsSync(join(home, ".feishu-agent", "official-skills")), "no cache directory is created on update failure");
});
