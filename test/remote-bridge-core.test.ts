import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { LoopbackOptions, ModelResponder, RemoteFixture } from "./helpers/remote-bridge-fixture.js";
import { EMPTY_REPLY_NOTICE } from "../packages/feishu-remote/extensions/remote-bridge.js";
import { THINKING_STATUS, WORKING_STATUS } from "../packages/feishu-remote/extensions/stream-card.js";
import {
  fixture,
  feishuLoopback,
  echoModel,
  runPty,
  closeServer,
  sse,
  sseDelta,
  sseDone,
  warningThenQuit,
  SECRET,
} from "./helpers/remote-bridge-fixture.js";

test("the connect handshake poll stays empty so scripted phone messages arrive only after it returns", async () => {
  const feishu = await feishuLoopback([
    { delayMs: 0, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "after-handshake", messageType: "text", text: "after-handshake" } },
  ]);
  try {
    const handshake = await fetch(`${feishu.url}/events`);
    assert.deepEqual(await handshake.json(), []);
    const delivered = await fetch(`${feishu.url}/events`);
    const events = (await delivered.json()) as Array<{ text?: string }>;
    assert.equal(events[0]?.text, "after-handshake");
  } finally {
    await closeServer(feishu.server);
  }
});

test("default startup opens no gateway connection; /remote status shows off", async () => {
  const f = await fixture(echoModel, []);
  try {
    const result = await runPty(f.project, [], f.env({}), [
      { wait: "fake-model", send: "/remote status\r" },
      { wait: "Remote bridge: off", send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    assert.doesNotMatch(result.output, /FEISHU_REMOTE_LOOPBACK_URL/);
    const stats = await f.feishu.stats();
    assert.equal(stats.polls, 0, "no loopback polling without activation");
    assert.equal(stats.sends.length, 0);
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("owner P2P message drives the session and gets one streaming card with the reply; strangers, groups and duplicates are ignored; stop/reload tear down", async () => {
  const f = await fixture(echoModel, [
    { delayMs: 400, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "msg-1", messageType: "text", text: "phone-message-1" } },
    { delayMs: 900, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "msg-1", messageType: "text", text: "phone-message-1" } },
    { delayMs: 1100, event: { ownerOpenId: "ou_intruder", chatId: "oc_phone", chatType: "p2p", messageId: "msg-2", messageType: "text", text: "intruder-message" } },
    { delayMs: 1300, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_group", chatType: "group", messageId: "msg-3", messageType: "text", text: "group-noise" } },
  ]);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "/remote start\r" },
      { wait: "Remote bridge connected", send: "" },
      { wait: "phone-message-1", send: "" },
      { wait: "PTY-PONG:phone-message-1", send: "/remote status\r" },
      { wait: "Remote bridge: connected", send: "/remote stop\r" },
      { wait: "Remote bridge stopped", send: "/remote status\r" },
      { wait: "Remote bridge: off", send: "/reload\r" },
      { wait: "Reloaded keybindings", send: "/remote status\r" },
      { wait: "Remote bridge: off", send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /remote:connected/);
    assert.doesNotMatch(result.output, /intruder-message|group-noise/);
    assert.doesNotMatch(result.output, /Agent is already processing/);
    const stats = await f.feishu.stats();
    assert.equal(stats.cards.opened.length, 1, JSON.stringify(stats.cards.opened));
    assert.equal(stats.cards.closes.length, 1, JSON.stringify(stats.cards.closes));
    assert.equal(stats.cards.closes[0].text, "PTY-PONG:phone-message-1", "final close delivers the complete reply");
    assert.equal(stats.sends.length, 0, "the reply rides on the card, not a plain message");
    assert(stats.closes.length >= 1, "gateway disconnect is recorded on stop");
    // Arrival sequence, not wall-clock time: Date.now() jumped backwards under
    // load in this sandbox, which made pre-teardown polls look post-teardown.
    // The server's monotonic seq still catches a poller that really kept polling.
    assert(stats.pollSeqs.every((seq) => seq <= stats.closeSeqs[0]), "no polling after teardown");

    assert.doesNotMatch(result.output, new RegExp(SECRET));
    for (const session of f.sessionFiles()) assert.doesNotMatch(session, new RegExp(SECRET), "app secret must not reach session files");
    assert.doesNotMatch(JSON.stringify(stats), new RegExp(SECRET), "app secret must not reach the loopback");
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("a mentioned group message drives the session and replies in that group", async () => {
  const f = await fixture(echoModel, [
    { delayMs: 400, event: { ownerOpenId: "ou_group_member", chatId: "oc_group", chatType: "group", mentionedBot: true, messageId: "group-msg-1", messageType: "text", text: "请回复群里的问题" } },
  ]);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "/remote start\r" },
      { wait: "Remote bridge connected", send: "" },
      { wait: "请回复群里的问题", send: "" },
      { wait: "PTY-PONG:请回复群里的问题", send: "/remote stop\r" },
      { wait: "Remote bridge stopped", send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    assert.equal(stats.reactions.length, 1);
    assert.deepEqual({ messageId: stats.reactions[0]?.messageId, emojiType: stats.reactions[0]?.emojiType }, { messageId: "group-msg-1", emojiType: "GLANCE" });
    assert.equal(stats.cards.opened[0]?.chatId, "oc_group");
    assert.equal(stats.cards.closes[0]?.text, "PTY-PONG:请回复群里的问题");
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("missing app secret on /remote start gives an actionable message and never connects", async () => {
  const f = await fixture(echoModel, []);
  try {
    const result = await runPty(f.project, [], f.env({}), [
      { wait: "fake-model", send: "/remote start\r" },
      { wait: "FEISHU_REMOTE_APP_SECRET", send: "/remote status\r" },
      { wait: "Remote bridge: error", send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /FEISHU_REMOTE_APP_SECRET/);
    assert.match(result.output, /remote:error/);
    const stats = await f.feishu.stats();
    assert.equal(stats.polls, 0, "missing secret must not connect");
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("FEISHU_REMOTE=1 autostarts and a message arriving during a busy turn is queued and answered without errors", async () => {
  const slowModel: ModelResponder = (lastUser) => ({
    delayMs: lastUser.includes("SLOW") ? 1500 : 0,
    sse: sse(`PTY-PONG:${lastUser}`),
  });
  const f = await fixture(slowModel, [
    { delayMs: 400, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "slow-1", messageType: "text", text: "SLOW-phone-1" } },
    { delayMs: 900, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "fast-2", messageType: "text", text: "followup-2" } },
  ]);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      { wait: "SLOW-phone-1", send: "" },
      { wait: "PTY-PONG:SLOW-phone-1", send: "" },
      { wait: "PTY-PONG:followup-2", send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    assert.doesNotMatch(result.output, /Agent is already processing/);
    assert.doesNotMatch(result.output, new RegExp(SECRET));
    const stats = await f.feishu.stats();
    assert.equal(stats.cards.opened.length, 2, JSON.stringify(stats.cards.opened));
    const replies = stats.cards.closes.map((card) => card.text);
    assert.equal(replies.length, 2, JSON.stringify(stats.cards.closes));
    assert.match(replies[0], /SLOW-phone-1/);
    assert.match(replies[1], /followup-2/);
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

for (const batched of [false, true]) test(`FEISHU_REMOTE=1 queues busy phone messages with acknowledgements, aborts on stop, and drains the queue in order (${batched ? "same-batch stop before agent start" : "staggered"})`, async () => {
  const slowModel: ModelResponder = (lastUser) => ({
    delayMs: lastUser.includes("SLOW") ? 4000 : 0,
    sse: sse(`PTY-PONG:${lastUser}`),
  });
  const script = [
    { delayMs: 400, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "slow-1", messageType: "text", text: "SLOW-phone-1" } },
    { delayMs: 650, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "fast-2", messageType: "text", text: "followup-2" } },
    { delayMs: 700, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "fast-3", messageType: "text", text: "followup-3" } },
    { delayMs: 800, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "stop-4", messageType: "text", text: "stop" } },
  ];
  const f = await fixture(slowModel, batched ? [{ delayMs: 400, event: script.map((step) => step.event) }] : script);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      { wait: "SLOW-phone-1", send: "" },
      { wait: "PTY-PONG:followup-3", send: "/remote status\r" },
      { wait: "Remote bridge: connected", send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    assert.doesNotMatch(result.output, /Agent is already processing/);
    assert.doesNotMatch(result.output, /PTY-PONG:SLOW-phone-1/, "stop must interrupt the slow turn before it replies");
    const stats = await f.feishu.stats();
    const acknowledgements = stats.sends.filter((send) => !send.text.startsWith("PTY-PONG:"));
    const ackTexts = acknowledgements.map((send) => send.text);
    assert.ok(ackTexts.some((text) => /queued.*position 1.*stop/i.test(text)), JSON.stringify(ackTexts));
    assert.ok(ackTexts.some((text) => /queued.*position 2.*stop/i.test(text)), JSON.stringify(ackTexts));
    assert.ok(ackTexts.some((text) => /interrupt|stopp/i.test(text)), JSON.stringify(ackTexts));
    const replies = stats.cards.closes.map((card) => card.text).filter((text) => text.startsWith("PTY-PONG:"));
    assert.deepEqual(replies, ["PTY-PONG:followup-2", "PTY-PONG:followup-3"]);
    // Busy acknowledgements are immediate: they are sent while the current turn is still
    // running, so every ack lands before the first queued reply settles.
    const firstReplyAt = Math.min(...stats.cards.closes.filter((card) => card.text.startsWith("PTY-PONG:")).map((card) => card.at));
    assert.ok(acknowledgements.every((send) => send.at < firstReplyAt), JSON.stringify({ acks: acknowledgements, firstReplyAt }));

    assert.doesNotMatch(result.output, new RegExp(SECRET));
    for (const session of f.sessionFiles()) assert.doesNotMatch(session, new RegExp(SECRET), "app secret must not reach session files");
    assert.doesNotMatch(JSON.stringify(stats), new RegExp(SECRET), "app secret must not reach the loopback");
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("non-text inbound messages (images/files/stickers) receive a v1 acknowledgement without starting a turn", async () => {
  const f = await fixture(echoModel, [
    { delayMs: 50, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "image-1", messageType: "image", text: "" } },
    { delayMs: 150, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "file-2", messageType: "file", text: "" } },
    { delayMs: 250, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "sticker-3", messageType: "sticker", text: "" } },
  ]);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "/remote status\r" },
      { wait: "app cli_fake_bridge", send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    assert.equal(stats.cards.opened.length, 0, "unsupported inbound content must not start an agent turn");
    assert.ok(stats.sends.some((send) => /unsupported.*image.*v1/i.test(send.text)), JSON.stringify(stats.sends));
    assert.ok(stats.sends.some((send) => /unsupported.*file.*v1/i.test(send.text)), JSON.stringify(stats.sends));
    assert.ok(stats.sends.some((send) => /unsupported.*sticker.*v1/i.test(send.text)), JSON.stringify(stats.sends));
    assert.doesNotMatch(result.output, /Agent is already processing/);
    assert.doesNotMatch(result.output, new RegExp(SECRET));
    assert.doesNotMatch(JSON.stringify(stats), new RegExp(SECRET), "app secret must not reach the loopback");
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("a provider error that Pi auto-retries still delivers the retried answer to the phone", async () => {
  let requests = 0;
  const flakyModel: ModelResponder = (lastUser) => {
    requests += 1;
    // A bodyless 502 is retryable: Pi ends the first run with an error-only
    // assistant message and starts a second run for the real answer.
    return requests === 1 ? { status: 502 } : { sse: sse(`PTY-PONG:${lastUser}`) };
  };
  const f = await fixture(flakyModel, [
    { delayMs: 300, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "retry-1", messageType: "text", text: "retry-me" } },
  ]);
  // Shorten the auto-retry backoff; the default is seconds. Merge into the
  // fixture settings: that file also holds the installed Remote Package.
  const settingsPath = join(f.home, ".feishu-agent", "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(readFileSync(settingsPath, "utf8")), retry: { enabled: true, maxRetries: 2, baseDelayMs: 100 } }));
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      { wait: "PTY-PONG:retry-me", send: "/remote status\r" },
      { wait: "Remote bridge: connected", send: "/quit\r" },
    ], 60, f.timeoutProgress);
    assert.equal(result.code, 0, result.output);
    assert.equal(requests, 2, "the provider error must be retried once");
    const stats = await f.feishu.stats();
    assert.equal(stats.cards.opened.length, 1, JSON.stringify(stats.cards.opened));
    assert.equal(stats.cards.closes.length, 1, JSON.stringify(stats.cards.closes));
    assert.equal(stats.cards.closes[0].text, "PTY-PONG:retry-me", "the retried run's answer must still reach the phone");
    assert.doesNotMatch(result.output, new RegExp(SECRET));
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("a card close that keeps failing delivers the complete reply as exactly one plain message and warns honestly", async () => {
  const f = await fixture(echoModel, [
    { delayMs: 300, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "close-fail-1", messageType: "text", text: "close-fail" } },
  ], { outboundFailures: { cardClose: Infinity } });
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      ...warningThenQuit("card close failed after a retry"),
    ], 60, f.timeoutProgress);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    assert.equal(stats.cards.closes.length, 0, "the card close never landed");
    assert.equal(stats.failures.filter((failure) => failure.endpoint === "cardClose").length, 2, "a failed close is retried exactly once");
    assert.deepEqual(stats.sends.map((send) => send.text), ["PTY-PONG:close-fail"], "the complete reply arrives as exactly one plain message");
    assert.match(result.output, /card close failed after a retry/);
    assert.match(result.output, /plain message/);
    assert.doesNotMatch(result.output, /still delivered/, "the warning must not claim a delivery that did not happen");
    assert.doesNotMatch(result.output, /connection interrupted/, "a card write failure is not a connection outage");
    assert.doesNotMatch(result.output, new RegExp(SECRET));
    for (const session of f.sessionFiles()) assert.doesNotMatch(session, new RegExp(SECRET), "app secret must not reach session files");
    assert.doesNotMatch(JSON.stringify(stats), new RegExp(SECRET));
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("a card close that fails once then succeeds finalizes the card without a plain message", async () => {
  const f = await fixture(echoModel, [
    { delayMs: 300, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "close-retry-1", messageType: "text", text: "close-retry" } },
  ], { outboundFailures: { cardClose: 1 } });
  const closed = join(f.root, "card-retry-closed");
  f.feishu.markCardClosed(closed);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      { wait: "PTY-PONG:close-retry", send: "" },
      { waitFile: closed, send: "/quit\r" },
    ], 60, f.timeoutProgress);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    assert.deepEqual(stats.failures.map((failure) => failure.endpoint), ["cardClose"]);
    assert.equal(stats.cards.closes.length, 1, JSON.stringify(stats.cards.closes));
    assert.equal(stats.cards.closes[0].text, "PTY-PONG:close-retry");
    assert.equal(stats.sends.length, 0, "a close that lands on retry must not duplicate the reply");
    assert.doesNotMatch(result.output, /plain message/);
    assert.doesNotMatch(result.output, new RegExp(SECRET));
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("a card creation failure delivers the complete reply as exactly one plain message", async () => {
  const f = await fixture(echoModel, [
    { delayMs: 300, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "open-fail-1", messageType: "text", text: "open-fail" } },
  ], { outboundFailures: { cardOpen: Infinity } });
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      ...warningThenQuit("could not open the streaming card"),
    ], 60, f.timeoutProgress);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    assert.equal(stats.cards.opened.length, 0, "no card was ever created");
    assert.deepEqual(stats.sends.map((send) => send.text), ["PTY-PONG:open-fail"], "the complete reply arrives as exactly one plain message");
    assert.match(result.output, /plain message/);
    assert.doesNotMatch(result.output, /still delivered/);
    assert.doesNotMatch(result.output, /connection interrupted/);
    assert.doesNotMatch(result.output, new RegExp(SECRET));
    for (const session of f.sessionFiles()) assert.doesNotMatch(session, new RegExp(SECRET), "app secret must not reach session files");
    assert.doesNotMatch(JSON.stringify(stats), new RegExp(SECRET));
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("a failed append with a successful close keeps the authoritative final text on the card, with no fallback", async () => {
  const f = await fixture(echoModel, [
    { delayMs: 300, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "append-fail-1", messageType: "text", text: "append-fail" } },
  ], { outboundFailures: { cardAppend: Infinity } });
  const closed = join(f.root, "append-fail-closed");
  f.feishu.markCardClosed(closed);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      { wait: "PTY-PONG:append-fail", send: "" },
      { waitFile: closed, send: "/quit\r" },
    ], 60, f.timeoutProgress);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    assert.equal(stats.cards.appends.length, 0, "every stream append failed");
    assert.equal(stats.cards.closes.length, 1, JSON.stringify(stats.cards.closes));
    assert.equal(stats.cards.closes[0].text, "PTY-PONG:append-fail", "the close decides the final text: no truncation");
    assert.equal(stats.sends.length, 0, "a non-fatal append failure must not trigger the plain-message fallback");
    assert.match(result.output, /card stream write failed/);
    assert.doesNotMatch(result.output, /still delivered/, "a stream write failure must not claim the reply was already delivered");
    assert.doesNotMatch(result.output, /plain message/);
    assert.doesNotMatch(result.output, /connection interrupted/);
    assert.doesNotMatch(result.output, new RegExp(SECRET));
    assert.doesNotMatch(JSON.stringify(stats), new RegExp(SECRET));
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("every turn warns again when the card stream keeps failing (the warning latch re-arms per turn)", async () => {
  const f = await fixture(echoModel, [
    { delayMs: 300, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "latch-1", messageType: "text", text: "latch-one" } },
    { delayMs: 600, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "latch-2", messageType: "text", text: "latch-two" } },
  ], { outboundFailures: { cardAppend: Infinity } });
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      { wait: "PTY-PONG:latch-one", send: "" },
      // Turn 1's warning is already behind this window, so the next match is turn 2's.
      { wait: "PTY-PONG:latch-two", send: "" },
      { wait: "card stream write failed", send: "/remote status\r" },
      { wait: "Remote bridge: connected", send: "/quit\r" },
    ], 60, f.timeoutProgress);
    assert.equal(result.code, 0, result.output);
    const warnings = result.output.match(/card stream write failed/g) ?? [];
    assert.equal(warnings.length, 2, `a card outage must warn on each affected turn, saw ${warnings.length}`);
    assert.equal((await f.feishu.stats()).sends.filter((send) => send.text.startsWith("PTY-PONG:")).length, 0, "a failed append never triggers the fallback");
    assert.doesNotMatch(result.output, new RegExp(SECRET));
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("tool execution shows a transient friendly status — even when the card is still opening — and clears it before finalizing", async () => {
  const toolResponses = [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "status-tool-1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf RAW_TOOL_OUTPUT_SHOULD_STAY_LOCAL" }) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
  ];
  const f = await fixture(() => {
    const tool = toolResponses.shift();
    return tool ? { sse: tool } : { stream: [
      { line: sseDelta({ content: "TOOL-STATUS-DONE" }), delayMs: 1000 },
      { line: sseDone(), delayMs: 0 },
    ] };
  }, [
    { delayMs: 100, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "status-1", messageType: "text", text: "run-tool" } },
  ], { cardOpenDelayMs: 150 });
  const finalized = join(f.root, "card-finalized");
  f.feishu.markCardClosed(finalized);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      // Visible streamed text is not evidence of turn/card completion.
      { waitFile: finalized, send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    const cardId = stats.cards.opened[0]?.cardId;
    const cardStatuses = stats.cards.statuses.filter((status) => status.cardId === cardId);
    const statusTexts = cardStatuses.map((status) => status.text);
    assert.ok(statusTexts.includes(WORKING_STATUS), `tool status must land on the card even while it was still opening: ${JSON.stringify(statusTexts)}`);
    // CardKit rejects empty content (HTTP 400 / 99992402 "the min len is 1"); the strip clears with a space.
    assert.ok(statusTexts.includes(" "), "the status line is cleared before the card finalizes");
    assert.ok(!statusTexts.includes(""), "empty content must never be sent to CardKit");
    assert.doesNotMatch(JSON.stringify(stats), /RAW_TOOL_OUTPUT_SHOULD_STAY_LOCAL/);
    assert.equal(stats.cards.closes[0]?.text, "TOOL-STATUS-DONE", "the finalized reply has no status line");
    assert.doesNotMatch(result.output, new RegExp(SECRET));
    assert.doesNotMatch(JSON.stringify(stats), new RegExp(SECRET));
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("reasoning before the answer keeps the tool status until visible assistant text actually starts", async () => {
  const stream: Array<{ line: string; delayMs: number }> = [
    { line: sseDelta({ reasoning_content: "THOUGHT-1" }), delayMs: 100 },
    { line: sseDelta({ reasoning_content: "THOUGHT-2" }), delayMs: 250 },
    { line: sseDelta({ reasoning_content: "THOUGHT-3" }), delayMs: 400 },
    { line: sseDelta({ content: "VISIBLE-ANSWER" }), delayMs: 550 },
    { line: sseDone(), delayMs: 10 },
  ];
  let toolCallSent = false;
  const toolFirst: ModelResponder = () => {
    if (!toolCallSent) {
      toolCallSent = true;
      return { sse: `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "reason-tool-1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "true" }) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n` };
    }
    return { stream };
  };
  const f = await fixture(toolFirst, [
    { delayMs: 100, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "reason-status-1", messageType: "text", text: "TOOL-FIRST" } },
  ]);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      { wait: "VISIBLE-ANSWER", send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    const firstAppendAt = Math.min(...stats.cards.appends.map((append) => append.at));
    const cleared = stats.cards.statuses.filter((status) => status.text === " ");
    assert.ok(stats.cards.statuses.some((status) => status.text === THINKING_STATUS), "reasoning and post-tool work return the card to the thinking status");
    assert.ok(cleared.length, "the status line is cleared eventually");
    assert.ok(!stats.cards.statuses.some((status) => status.text === ""), "empty content must never be sent to CardKit");
    for (const clear of cleared) assert.ok(firstAppendAt - clear.at < 200, `status must clear when visible text starts, not at message_start: clear=${clear.at} firstAppend=${firstAppendAt}`);
    assert.doesNotMatch(JSON.stringify(stats.cards.appends), /THOUGHT-/, "reasoning never reaches the card");
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

// A model that always answers with a retryable provider error, plus the fixture's
// short retry budget so the exhausted-retry settle happens inside the test window.
async function providerDownFixture(messageId: string, loopback: LoopbackOptions = {}): Promise<RemoteFixture> {
  const f = await fixture(() => ({ status: 502 }), [
    { delayMs: 300, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId, messageType: "text", text: "provider-down" } },
  ], loopback);
  const settingsPath = join(f.home, ".feishu-agent", "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(readFileSync(settingsPath, "utf8")), retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 } }));
  return f;
}

test("a settle with no visible reply closes the card with a short notice instead of empty content", async () => {
  // First low-level run calls a tool (whose raw output must stay local); the run
  // that answers emits internal reasoning only, so the turn has no visible text.
  const toolCall = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "notice-tool-1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf RAW_TOOL_OUTPUT_SHOULD_STAY_LOCAL" }) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
  let toolSent = false;
  const reasoningOnly: ModelResponder = () => {
    if (!toolSent) {
      toolSent = true;
      return { sse: toolCall };
    }
    return { sse: sseDelta({ reasoning_content: "THOUGHT-ONLY-RAW" }) + sseDone() };
  };
  const f = await fixture(reasoningOnly, [
    { delayMs: 300, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "reasoning-only-1", messageType: "text", text: "reasoning-only" } },
  ]);
  const closed = join(f.root, "reasoning-only-closed");
  f.feishu.markCardClosed(closed);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      { waitFile: closed, send: "/quit\r" },
    ], 60, f.timeoutProgress);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    assert.equal(stats.cards.opened.length, 1, JSON.stringify(stats.cards.opened));
    assert.equal(stats.cards.closes.length, 1, JSON.stringify(stats.cards.closes));
    assert.equal(stats.cards.closes[0]?.text, EMPTY_REPLY_NOTICE, "the phone gets a short notice instead of an empty card");
    assert.match(stats.cards.closes[0]?.text ?? "", /ended without a reply/, "the notice is non-empty even if the constant regresses");
    assert.equal(stats.sends.length, 0, "the notice rides the card: a one-card turn gains no plain message");
    assert.doesNotMatch(JSON.stringify(stats), /THOUGHT-ONLY-RAW/, "the notice must not carry raw thinking");
    assert.ok(f.timeoutProgress().modelRequests >= 2, "the tool round-trip happened before the notice");
    assert.doesNotMatch(JSON.stringify(stats), /RAW_TOOL_OUTPUT_SHOULD_STAY_LOCAL/, "the notice must not carry raw tool output");
    assert.doesNotMatch(result.output, new RegExp(SECRET));
    assert.doesNotMatch(JSON.stringify(stats), new RegExp(SECRET));
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("provider errors that exhaust Pi's auto-retry leave a short notice on the card, not an empty card", async () => {
  const f = await providerDownFixture("provider-down-1");
  const closed = join(f.root, "provider-down-closed");
  f.feishu.markCardClosed(closed);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      { waitFile: closed, send: "/quit\r" },
    ], 60, f.timeoutProgress);
    assert.equal(result.code, 0, result.output);
    assert.ok(f.timeoutProgress().modelRequests >= 2, "the provider error must be retried before the settle");
    const stats = await f.feishu.stats();
    assert.equal(stats.cards.closes.length, 1, JSON.stringify(stats.cards.closes));
    assert.equal(stats.cards.closes[0]?.text, EMPTY_REPLY_NOTICE, "the phone gets a short notice instead of an empty card");
    assert.match(stats.cards.closes[0]?.text ?? "", /ended without a reply/, "the notice is non-empty even if the constant regresses");
    assert.equal(stats.sends.length, 0, "the notice rides the card: a one-card turn gains no plain message");
    assert.doesNotMatch(result.output, new RegExp(SECRET));
    assert.doesNotMatch(JSON.stringify(stats), new RegExp(SECRET));
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("when the card never opens, a no-visible-reply settle arrives as exactly one plain notice", async () => {
  const f = await providerDownFixture("provider-down-no-card", { outboundFailures: { cardOpen: Infinity } });
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      { wait: "could not open the streaming card", send: "/quit\r" },
    ], 60, f.timeoutProgress);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    assert.equal(stats.cards.opened.length, 0, "the card never opened");
    assert.equal(stats.cards.closes.length, 0);
    assert.deepEqual(stats.sends.map((send) => send.text), [EMPTY_REPLY_NOTICE], "the notice arrives as exactly one plain message");
    assert.match(stats.sends[0]?.text ?? "", /ended without a reply/, "the notice is non-empty even if the constant regresses");
    assert.match(result.output, /notice was sent as a plain message/);
    assert.doesNotMatch(result.output, new RegExp(SECRET));
    assert.doesNotMatch(JSON.stringify(stats), new RegExp(SECRET));
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("a notice that cannot be delivered does not affect settlement; the bridge keeps running", async () => {
  const f = await providerDownFixture("provider-down-undeliverable", { outboundFailures: { cardOpen: Infinity, sendMessage: Infinity } });
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      ...warningThenQuit("could not be sent either"),
    ], 60, f.timeoutProgress);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    assert.equal(stats.sends.length, 0, "the failed notice never reaches the wire");
    assert.equal(stats.failures.filter((failure) => failure.endpoint === "sendMessage").length, 1);
    assert.match(result.output, /notice could not be sent either/);
    assert.doesNotMatch(result.output, new RegExp(SECRET));
    assert.doesNotMatch(JSON.stringify(stats), new RegExp(SECRET));
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

// Hung outbound calls are the whole point of the outbound budget: the fake never
// answers, so only the client-side bound lets settlement and /quit finish. The
// budget itself is the product default; the test only shrinks it through the env
// var. 2s is comfortably above localhost round-trip jitter under a loaded suite
// (500ms produced false timeouts) and small enough to keep each hung path quick.
const HANG_BUDGET_ENV = { FEISHU_REMOTE_OUTBOUND_TIMEOUT_MS: "2000" };

test("a hung card close is bounded: the complete reply arrives once as a plain message and the TUI frees up", async () => {
  const f = await fixture(echoModel, [
    { delayMs: 300, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "close-hang-1", messageType: "text", text: "close-hang" } },
  ], { hangOutbound: { cardClose: Infinity } });
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url, ...HANG_BUDGET_ENV }), [
      ...warningThenQuit("card close failed after a retry"),
    ], 60, f.timeoutProgress);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    assert.equal(stats.cards.closes.length, 0, "the hung close never lands");
    assert.equal(stats.hangs.filter((hang) => hang.endpoint === "cardClose").length, 2, "the hung close is retried exactly once, and both attempts are bounded");
    assert.deepEqual(stats.sends.map((send) => send.text), ["PTY-PONG:close-hang"], "the complete reply arrives as exactly one plain message");
    assert.match(result.output, /card close failed after a retry/);
    assert.match(result.output, /plain message/);
    assert.match(result.output, /timed out after 2000ms/, "the warning names the injected budget, so the timeout did not come from a call-site literal");
    assert.doesNotMatch(result.output, new RegExp(SECRET));
    assert.doesNotMatch(JSON.stringify(stats), new RegExp(SECRET));
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("a hung card append cannot hold card finalization: the close still lands with the complete reply", async () => {
  const f = await fixture(echoModel, [
    { delayMs: 300, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "append-hang-1", messageType: "text", text: "append-hang" } },
  ], { hangOutbound: { cardAppend: Infinity } });
  const closed = join(f.root, "append-hang-closed");
  f.feishu.markCardClosed(closed);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url, ...HANG_BUDGET_ENV }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      { waitFile: closed, send: "/quit\r" },
    ], 60, f.timeoutProgress);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    assert.equal(stats.cards.appends.length, 0, "every stream append hung");
    assert.ok(stats.hangs.some((hang) => hang.endpoint === "cardAppend"), "the append reached the wire and hung");
    assert.equal(stats.cards.closes.length, 1, JSON.stringify(stats.cards.closes));
    assert.equal(stats.cards.closes[0]?.text, "PTY-PONG:append-hang", "the close decides the final text: the hung append cannot block or truncate it");
    assert.equal(stats.sends.length, 0, "a hung append must not trigger the plain-message fallback");
    assert.match(result.output, /card stream write failed/);
    assert.doesNotMatch(result.output, new RegExp(SECRET));
    assert.doesNotMatch(JSON.stringify(stats), new RegExp(SECRET));
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("a hung card open still settles within the budget: the reply arrives as one plain message and /quit exits", async () => {
  const f = await fixture(echoModel, [
    { delayMs: 300, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "open-hang-1", messageType: "text", text: "open-hang" } },
  ], { hangOutbound: { cardOpen: Infinity } });
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url, ...HANG_BUDGET_ENV }), [
      ...warningThenQuit("could not open the streaming card"),
    ], 60, f.timeoutProgress);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    assert.equal(stats.cards.opened.length, 0, "the hung open never returns a card");
    assert.equal(stats.hangs.filter((hang) => hang.endpoint === "cardOpen").length, 1, "the hung open is not retried; the fallback is the single retry");
    assert.deepEqual(stats.sends.map((send) => send.text), ["PTY-PONG:open-hang"], "the complete reply arrives as exactly one plain message");
    assert.match(result.output, /could not open the streaming card/);
    assert.match(result.output, /timed out after 2000ms/);
    assert.doesNotMatch(result.output, new RegExp(SECRET));
    assert.doesNotMatch(JSON.stringify(stats), new RegExp(SECRET));
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("a hung plain-message fallback is bounded too: the turn still settles and reports the fallback failure", async () => {
  const f = await fixture(echoModel, [
    { delayMs: 300, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "send-hang-1", messageType: "text", text: "send-hang" } },
  ], { hangOutbound: { cardClose: Infinity, sendMessage: Infinity } });
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url, ...HANG_BUDGET_ENV }), [
      ...warningThenQuit("plain-message fallback also failed"),
    ], 60, f.timeoutProgress);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    assert.equal(stats.sends.length, 0, "the hung fallback never reaches the wire");
    assert.equal(stats.hangs.filter((hang) => hang.endpoint === "sendMessage").length, 1, "the hung fallback is attempted exactly once, bounded");
    assert.deepEqual([...new Set(stats.hangs.map((hang) => hang.endpoint))].sort(), ["cardClose", "sendMessage"]);
    assert.match(result.output, /plain-message fallback also failed/);
    assert.doesNotMatch(result.output, new RegExp(SECRET));
    assert.doesNotMatch(JSON.stringify(stats), new RegExp(SECRET));
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});
