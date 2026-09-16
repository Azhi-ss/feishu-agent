import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  fixture,
  echoModel,
  runPty,
  closeServer,
  SECRET,
  lockFile,
  plantLock,
} from "./helpers/remote-bridge-fixture.js";


test("a live process holding the app lock makes /remote start fail with that pid", async () => {
  const f = await fixture(echoModel, []);
  try {
    plantLock(f.home, process.pid);
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "/remote start\r" },
      { wait: "already running", send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, new RegExp(`already running \\(pid ${process.pid}`));
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("/remote switch hands the bridge off from the holding window to the new one", async () => {
  const f = await fixture(echoModel, []);
  try {
    const first = runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "Remote bridge connected", send: "" },
      { wait: "remote:off", send: "/quit\r" },
    ]);
    let holderPid: number | undefined;
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        const parsed = JSON.parse(readFileSync(lockFile(f.home), "utf8")) as { pid: number; cwd: string };
        if (parsed.pid) { holderPid = parsed.pid; break; }
      } catch { /* lock not written yet */ }
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.ok(holderPid, "the first window must acquire the lock");
    // Wait for the holder to finish connecting: the loopback's first long-poll
    // flushes on a 2s waiter timeout, so allow well beyond that before switching.
    await new Promise((done) => setTimeout(done, 3_500));
    const switched = await runPty(f.project, [], f.env({ FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "/remote switch\r" },
      { wait: "Remote bridge connected", send: "/quit\r" },
    ]);
    assert.equal(switched.code, 0, switched.output);
    assert.match(switched.output, /Remote bridge connected/);
    assert.doesNotMatch(switched.output, /handover failed|did not release/);
    const firstResult = await first;
    assert.equal(firstResult.code, 0, firstResult.output);
    assert.match(firstResult.output, /remote:off/);
    assert.doesNotMatch(firstResult.output, /Remote bridge connected[\s\S]*Remote bridge connected/);
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("FEISHU_REMOTE=1 enters standby quietly when another live window holds the lock", async () => {
  const f = await fixture(echoModel, []);
  const release = join(f.root, "release-standby");
  try {
    const first = runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "Remote bridge connected", send: "" },
      { waitFile: release, send: "/quit\r" },
    ]);
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        const parsed = JSON.parse(readFileSync(lockFile(f.home), "utf8")) as { pid: number };
        if (parsed.pid) break;
      } catch { /* lock not written yet */ }
      await new Promise((done) => setTimeout(done, 50));
    }
    const waiting = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "standby", send: "/remote status\r" },
      { wait: "standby", send: "/quit\r" },
    ]);
    assert.equal(waiting.code, 0, waiting.output);
    assert.match(waiting.output, /standby \(held by pid \d+ in project\)/);
    assert.match(waiting.output, /remote:standby/);
    // Autostart standby must be quiet: no error-level notification.
    assert.doesNotMatch(waiting.output, /Remote bridge could not connect/);
    writeFileSync(release, "go\n");
    const firstResult = await first;
    assert.equal(firstResult.code, 0, firstResult.output);
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});
