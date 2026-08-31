import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { projectKeyFor, sessionManagerFor } from "../src/sessions.js";

test("session keys partition projects while launch cwd remains current", () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-sessions-"));
  const home = join(root, "home", ".feishu-agent");
  const one = join(root, "one", "same");
  const two = join(root, "two", "same");
  mkdirSync(one, { recursive: true });
  mkdirSync(two, { recursive: true });
  assert.notEqual(projectKeyFor(one), projectKeyFor(two));
  const manager = sessionManagerFor(home, one, one, false);
  assert.equal(manager.getCwd(), one);
  assert.match(manager.getSessionDir(), new RegExp(`${basename(one)}-`));
  assert.match(manager.getSessionDir(), /^.*\.feishu-agent\/sessions\//);
});
