import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { FeishuStats } from "./helpers/remote-bridge-fixture.js";
import {
  fixture,
  echoModel,
  runPty,
  closeServer,
  SECRET,
  plantLock,
  deadPid,
} from "./helpers/remote-bridge-fixture.js";

test("a second session cannot start the bridge while the first holds the app lock", async () => {
  const f = await fixture(echoModel, []);
  const release = join(f.root, "release-first");
  try {
    const first = runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "Remote bridge connected", send: "" },
      { waitFile: release, send: "/remote stop\r" },
      { wait: "Remote bridge stopped", send: "/quit\r" },
    ]);
    for (let attempt = 0; attempt < 300; attempt++) {
      if ((await f.feishu.stats()).polls > 0) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    const blocked = await runPty(f.project, [], f.env({ FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "/remote start\r" },
      { wait: "already running", send: "/quit\r" },
    ]);
    assert.equal(blocked.code, 0, blocked.output);
    assert.match(blocked.output, /already running \(pid \d+/);
    writeFileSync(release, "go\n");
    const firstResult = await first;
    assert.equal(firstResult.code, 0, firstResult.output);
    const takeover = await runPty(f.project, [], f.env({ FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "/remote start\r" },
      { wait: "Remote bridge connected", send: "/quit\r" },
    ]);
    assert.equal(takeover.code, 0, takeover.output);
    assert.match(takeover.output, /Remote bridge connected/);
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("replacing the session while the bridge is still connecting does not inject on a stale runner", async () => {
  const holdHandshake = join(mkdtempSync(join(tmpdir(), "feishu-remote-hold-")), "release-handshake");
  const afterReplace = join(dirname(holdHandshake), "after-replace");
  const f = await fixture(echoModel, [
    { delayMs: 0, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "after-new-1", messageType: "text", text: "after-new" } },
  ], { holdFirstPollUntil: holdHandshake });
  try {
    const resultP = runPty(f.project, [], f.env({ FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "/remote start\r" },
      { wait: "remote:connecting", send: "/new\r" },
      { wait: "New session started", send: "" },
      { waitFile: afterReplace, send: "/quit\r" },
    ]);
    let mid: FeishuStats | undefined;
    for (let attempt = 0; attempt < 300; attempt++) {
      mid = await f.feishu.stats();
      if (mid.closes.length >= 1) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.ok((mid?.closes.length ?? 0) >= 1, "session replacement must disconnect the in-flight handshake before the runner is invalidated");
    assert.equal(mid?.cards.opened.length ?? 0, 0);
    writeFileSync(afterReplace, "go\n");
    const result = await resultP;
    assert.equal(result.code, 0, result.output);
    assert.doesNotMatch(result.output, /stale after session/);
    assert.doesNotMatch(result.output, /Remote bridge could not start the turn/);
    assert.doesNotMatch(result.output, /PTY-PONG:after-new/, "a phone message must not land in the replaced session");
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("a stale lock from a dead process is reclaimed so /remote start can connect", async () => {
  const f = await fixture(echoModel, []);
  try {
    plantLock(f.home, await deadPid());
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "Remote bridge connected", send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Remote bridge connected/);
    assert.doesNotMatch(result.output, /already running/);
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});
