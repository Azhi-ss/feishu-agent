// Stop-time finalization semantics: /remote stop, a handoff requested by another
// window's /remote switch, session replacement and process shutdown all close an
// in-flight card with the most complete reply body known at that moment (never
// empty content that erases what the phone already saw), and stopping with a
// non-empty phone queue tells the phone how many messages went unanswered.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type { ModelResponder } from "./helpers/remote-bridge-fixture.js";
import { waitFor } from "./helpers/automation-cli-fixture.js";
import { droppedQueueNotice } from "../packages/feishu-remote/extensions/remote-bridge.js";
import {
  fixture,
  closeServer,
  runPty,
  sse,
  sseDelta,
  sseDone,
  SECRET,
  lockFile,
} from "./helpers/remote-bridge-fixture.js";

const CHUNKS = ["STOP-A-", "STOP-B-", "STOP-C-", "STOP-D-", "STOP-E-", "STOP-F-", "STOP-G-", "STOP-H-"];
const STREAMED_REPLY = CHUNKS.join("");

const phone = (messageId: string, text: string) => ({ ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId, messageType: "text", text });

/** One visible chunk every `delayMs`, so a test can stop the bridge mid-answer. */
function streamingModel(delayMs = 400): ModelResponder {
  const stream = CHUNKS.map((content) => ({ line: sseDelta({ content }), delayMs }));
  stream.push({ line: sseDone(), delayMs: 0 });
  return () => ({ stream });
}

function assertStreamedPrefix(finalText: string): void {
  assert.ok(finalText.length > 0, "finalization must not erase what the phone already saw with an empty body");
  assert.ok(STREAMED_REPLY.startsWith(finalText), `the final body must be the streamed prefix, got ${JSON.stringify(finalText)}`);
}

function longestServed(stats: { cards: { appends: Array<{ cardId: string; text: string }> } }, cardId: string): string {
  return stats.cards.appends.filter((append) => append.cardId === cardId).map((append) => append.text)
    .reduce((longest, text) => (text.length > longest.length ? text : longest), "");
}

test("the dropped-message notice names the count in singular and plural", () => {
  assert.equal(droppedQueueNotice(1), "Remote bridge stopped: 1 queued message did not get an answer.");
  assert.equal(droppedQueueNotice(2), "Remote bridge stopped: 2 queued messages did not get an answer.");
});

test("/remote stop mid-turn closes the card with the reply body it already streamed, never an empty card", async () => {
  const f = await fixture(streamingModel(), [{ delayMs: 300, event: phone("stop-mid-1", "slow-stream") }]);
  const closed = join(f.root, "stop-mid-closed");
  f.feishu.markCardClosed(closed);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      { wait: "STOP-A-", send: "" },
      { wait: "STOP-B-", send: "/remote stop\r" },
      { wait: "Remote bridge stopped", send: "" },
      { waitFile: closed, send: "/quit\r" },
    ], 60, f.timeoutProgress);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    assert.equal(stats.cards.closes.length, 1, JSON.stringify(stats.cards.closes));
    const finalText = stats.cards.closes[0].text;
    assertStreamedPrefix(finalText);
    const served = longestServed(stats, stats.cards.closes[0].cardId);
    assert.ok(finalText.length >= served.length, `the close must not shrink below content the server already served (${JSON.stringify({ finalText, served })})`);
    assert.equal(stats.sends.length, 0, "an empty queue means no dropped-message notice");
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("process shutdown mid-turn shares the stop finalization: the card closes with the streamed reply body", async () => {
  const f = await fixture(streamingModel(), [{ delayMs: 300, event: phone("shutdown-mid-1", "slow-stream") }]);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      { wait: "STOP-A-", send: "" },
      { wait: "STOP-B-", send: "/quit\r" },
    ], 60, f.timeoutProgress);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    assert.equal(stats.cards.closes.length, 1, JSON.stringify(stats.cards.closes));
    assertStreamedPrefix(stats.cards.closes[0].text);
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("a handoff requested by another window's /remote switch mid-turn finalizes the holder's card with the streamed body, and the new window then delivers a reply", async () => {
  const responder: ModelResponder = (lastUser) => (lastUser.includes("after-handoff") ? { sse: sse("PTY-PONG:after-handoff") } : streamingModel()(lastUser));
  const f = await fixture(responder, [
    { delayMs: 300, event: phone("switch-mid-1", "slow-stream") },
    { delayMs: 9000, event: phone("switch-mid-2", "after-handoff") },
  ]);
  try {
    const holder = runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      { wait: "STOP-A-", send: "" },
      { wait: "remote:off", send: "/quit\r" },
    ], 60, f.timeoutProgress);
    // The holder must already own the card and have streamed a segment, so the
    // handoff really interrupts an in-flight turn.
    await waitFor(async () => {
      try {
        if (!(JSON.parse(readFileSync(lockFile(f.home), "utf8")) as { pid?: number }).pid) return false;
      } catch { return false; }
      const stats = await f.feishu.stats();
      return stats.cards.opened.length === 1 && stats.cards.appends.length >= 1;
    });
    const switched = await runPty(f.project, [], f.env({ FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "/remote switch\r" },
      { wait: "Remote bridge connected", send: "" },
      { wait: "PTY-PONG:after-handoff", send: "/quit\r" },
    ], 60, f.timeoutProgress);
    assert.equal(switched.code, 0, switched.output);
    assert.doesNotMatch(switched.output, /handover failed|did not release/);
    const holderResult = await holder;
    assert.equal(holderResult.code, 0, holderResult.output);
    assert.match(holderResult.output, /remote:off/);
    const stats = await f.feishu.stats();
    assert.equal(stats.cards.closes.length, 2, JSON.stringify(stats.cards.closes));
    assertStreamedPrefix(stats.cards.closes[0].text);
    assert.equal(stats.cards.closes[1].text, "PTY-PONG:after-handoff", "the window that took over still delivers the next reply");
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("/remote stop with queued phone messages tells the phone how many went unanswered, exactly once", async () => {
  const f = await fixture(streamingModel(), [
    { delayMs: 300, event: phone("drop-1", "slow-stream") },
    { delayMs: 700, event: phone("drop-2", "QUEUED-2") },
    { delayMs: 760, event: phone("drop-3", "QUEUED-3") },
  ]);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      { wait: "STOP-A-", send: "" },
      // STOP-C is ~1.1s into the stream; the two queued messages landed at ~0.7s.
      { wait: "STOP-C-", send: "/remote stop\r" },
      { wait: "Remote bridge stopped", send: "/quit\r" },
    ], 60, f.timeoutProgress);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    const notices = stats.sends.filter((send) => /did not get an answer/.test(send.text));
    assert.deepEqual(notices.map((send) => send.text), ["Remote bridge stopped: 2 queued messages did not get an answer."], "the phone gets the dropped count once, never a retry queue");
    assert.equal(stats.cards.closes.length, 1, JSON.stringify(stats.cards.closes));
    assert.ok(stats.cards.closes[0].text.length > 0, "the interrupted card still closes with a non-empty body");
    assert.doesNotMatch(result.output, new RegExp(SECRET));
    assert.doesNotMatch(JSON.stringify(stats), new RegExp(SECRET));
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("when the stop-time card close does not land, the phone still gets the streamed reply body as one plain message", async () => {
  const f = await fixture(streamingModel(), [
    { delayMs: 300, event: phone("stop-close-fail-1", "slow-stream") },
  ], { outboundFailures: { cardClose: Infinity } });
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      { wait: "STOP-A-", send: "" },
      { wait: "STOP-B-", send: "/remote stop\r" },
      { wait: "Remote bridge stopped", send: "/quit\r" },
    ], 60, f.timeoutProgress);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    assert.equal(stats.cards.closes.length, 0, "the card close never landed");
    assert.equal(stats.failures.filter((failure) => failure.endpoint === "cardClose").length, 2, "a failed close is retried exactly once");
    assert.equal(stats.sends.length, 1, JSON.stringify(stats.sends));
    assertStreamedPrefix(stats.sends[0].text);
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("session replacement (/new mid-turn) finalizes the card with the streamed body and does not leave the bridge connected", async () => {
  const f = await fixture(streamingModel(), [{ delayMs: 300, event: phone("new-mid-1", "slow-stream") }]);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "/remote start\r" },
      { wait: "Remote bridge connected", send: "" },
      { wait: "STOP-A-", send: "" },
      { wait: "STOP-B-", send: "/new\r" },
      { wait: "New session started", send: "" },
      { wait: "remote:off", send: "/quit\r" },
    ], 60, f.timeoutProgress);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    assert.equal(stats.cards.closes.length, 1, JSON.stringify(stats.cards.closes));
    assertStreamedPrefix(stats.cards.closes[0].text);
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("/reload session replacement finalizes the card with the reply body and does not leave the bridge connected", async () => {
  const f = await fixture(streamingModel(), [{ delayMs: 300, event: phone("reload-mid-1", "slow-stream") }]);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "/remote start\r" },
      { wait: "Remote bridge connected", send: "" },
      { wait: "STOP-A-", send: "" },
      { wait: "STOP-B-", send: "/reload\r" },
      { wait: "Reloaded keybindings", send: "" },
      { wait: "remote:off", send: "/quit\r" },
    ], 60, f.timeoutProgress);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    assert.equal(stats.cards.closes.length, 1, JSON.stringify(stats.cards.closes));
    assertStreamedPrefix(stats.cards.closes[0].text);
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});
