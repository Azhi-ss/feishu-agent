import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { closeServer, fixture, lockFile, pidIsAlive, runPty, SECRET, sse, sseDelta } from "./helpers/remote-bridge-fixture.js";

test("PTY timeout progress precedes shutdown finalization of a controlled unfinished stream", async () => {
  const f = await fixture(() => ({ stream: [{ line: sseDelta({ content: "UNFINISHED-STREAM" }), delayMs: 30_000 }] }), [
    { delayMs: 400, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "unfinished-1", messageType: "text", text: "diagnostic-only" } },
  ]);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "UNFINISHED-STREAM" },
      { wait: "DIAGNOSTIC-NEVER-ARRIVES" },
    ], 12, f.timeoutProgress);
    assert.equal(result.code, 124);
    const diagnostic = JSON.parse(result.output.slice("PTY_TIMEOUT ".length));
    assert.equal(diagnostic.progress.modelRequests, 1);
    assert.equal(diagnostic.progress.modelResponsesFinished, 0);
    assert.equal(diagnostic.progress.cardsOpened, 1);
    assert.equal(diagnostic.progress.cardsClosed, 0, "deadline evidence must precede shutdown finalization");
    assert.equal((await f.feishu.stats()).cards.closes.length, 1, "shutdown finalizes the previously unfinished card");
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("PTY timeout diagnostics: controlled stall validates diagnostics, not the historical guard failure", async () => {
  const mem0Key = "FAKE-MEM0-diagnostic-key";
  const larkToken = "FAKE-LARK-diagnostic-token";
  let cliPid: number | undefined;
  const f = await fixture(() => {
    // Capture the live CLI identity before timeout shutdown removes its lock.
    cliPid = JSON.parse(readFileSync(lockFile(f.home), "utf8")).pid;
    return { sse: sse(`DIAGNOSTIC-TAIL ${SECRET} ${mem0Key} ${larkToken} fake-key`) };
  }, [
    { delayMs: 400, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "diagnostic-1", messageType: "text", text: "diagnostic-only" } },
  ]);
  try {
    const result = await runPty(f.project, [], f.env({
      FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url,
      MEM0_API_KEY: mem0Key, LARK_TOKEN: larkToken,
    }), [
      { wait: "DIAGNOSTIC-TAIL" },
      { wait: "DIAGNOSTIC-NEVER-ARRIVES" },
    ], 12, f.timeoutProgress);
    assert.equal(result.code, 124, "controlled stall must retain the timeout exit code");
    // Never put the deliberately echoed fake credentials in assertion diagnostics.
    assert.ok(result.output.startsWith("PTY_TIMEOUT "), "timeout must report a structured diagnostic");
    assert.ok(![SECRET, mem0Key, larkToken, "fake-key"].some((secret) => result.output.includes(secret)), "diagnostics must redact fixture credentials");
    const diagnostic = JSON.parse(result.output.slice("PTY_TIMEOUT ".length));
    assert.equal(diagnostic.action, 1);
    assert.equal(diagnostic.totalActions, 2);
    assert.equal(diagnostic.expected, "DIAGNOSTIC-NEVER-ARRIVES");
    assert.ok(diagnostic.elapsedSec >= 12 && diagnostic.elapsedSec < 15);
    assert.deepEqual(diagnostic.progress, { modelRequests: 1, modelResponsesFinished: 1, cardsOpened: 1, cardAppends: 1, cardsClosed: 1 });
    assert.ok(diagnostic.tail.length <= 4096);
    assert.match(diagnostic.tail, /DIAGNOSTIC-TAIL/);
    assert.match(diagnostic.tail, /\[REDACTED\]/);
    assert.ok(!diagnostic.tail.includes("\x1b"), "tail must not contain terminal escapes");
    assert.ok(cliPid, "capture the CLI PID while its model request is in flight");
    assert.equal(pidIsAlive(cliPid), false, "timed-out CLI must be reaped before returning");
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});
