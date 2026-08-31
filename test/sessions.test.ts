import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { projectKeyFor, sessionManagerFor, cwdMismatchNotice } from "../src/sessions.js";

test("session keys partition projects while launch cwd remains current", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-sessions-"));
  const home = join(root, "home", ".feishu-agent");
  const one = join(root, "one", "same");
  const two = join(root, "two", "same");
  mkdirSync(one, { recursive: true });
  mkdirSync(two, { recursive: true });
  assert.notEqual(projectKeyFor(one), projectKeyFor(two));
  const selection = await sessionManagerFor(home, one, one, false);
  const manager = selection.manager;
  assert.equal(manager.getCwd(), one);
  assert.match(manager.getSessionDir(), new RegExp(`${basename(one)}-`));
  assert.match(manager.getSessionDir(), /^.*\.feishu-agent\/sessions\//);
});

test("continue selects newest project session across subdirectories and overrides cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-sessions-resume-"));
  const home = join(root, "home", ".feishu-agent");
  const project = join(root, "repo");
  const one = join(project, "one");
  const two = join(project, "two");
  mkdirSync(one, { recursive: true }); mkdirSync(two, { recursive: true });
  const first = (await sessionManagerFor(home, project, one, false)).manager;
  first.appendMessage({ role: "user", content: "older", timestamp: Date.now() } as never);
  first.appendMessage({ role: "assistant", content: [{ type: "text", text: "older answer" }], timestamp: Date.now(), stopReason: "stop", usage: {} } as never);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = (await sessionManagerFor(home, project, two, false)).manager;
  second.appendMessage({ role: "user", content: "newer", timestamp: Date.now() } as never);
  second.appendMessage({ role: "assistant", content: [{ type: "text", text: "newer answer" }], timestamp: Date.now(), stopReason: "stop", usage: {} } as never);
  const sessions = await SessionManager.listAll(second.getSessionDir());
  const newest = sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime() || b.created.getTime() - a.created.getTime())[0];
  const resumed = await sessionManagerFor(home, project, one, true);
  assert.notEqual(first.getSessionFile(), second.getSessionFile());
  assert(newest);
  assert.equal(resumed.manager.getSessionFile(), newest.path);
  assert.equal(resumed.manager.getCwd(), one);
  assert.match(cwdMismatchNotice(resumed.originalCwd, one)!, /created in .*two.*runtime CWD.*one/);
});
