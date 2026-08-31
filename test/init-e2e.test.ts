import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The init command is a thin orchestration over separately behavior-tested Home,
// readiness, package-manager, and official-Skill modules.
test("init orchestration keeps telemetry disabled before package work", () => {
  const source = readFileSync(new URL("../../src/cli.ts", import.meta.url), "utf8");
  assert(source.indexOf('process.env.MEM0_TELEMETRY = "false"') < source.indexOf('from "./packages.js"'));
  assert.match(source, /installAndPersist\("npm:@mem0\/pi-agent-plugin@0\.1\.5"\)/);
  assert.match(source, /syncOfficialSkills/);
  assert.match(source, /checkReadiness/);
});
