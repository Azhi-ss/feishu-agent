import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
