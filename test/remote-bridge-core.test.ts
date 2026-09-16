import assert from "node:assert/strict";
import test from "node:test";
import type { ModelResponder } from "./helpers/remote-bridge-fixture.js";
import {
  fixture,
  echoModel,
  runPty,
  closeServer,
  sse,
  sseDelta,
  sseDone,
  SECRET,
} from "./helpers/remote-bridge-fixture.js";

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
    assert(stats.pollTimes.every((time) => time <= stats.closes[0]), "no polling after teardown");

    assert.doesNotMatch(result.output, new RegExp(SECRET));
    for (const session of f.sessionFiles()) assert.doesNotMatch(session, new RegExp(SECRET), "app secret must not reach session files");
    assert.doesNotMatch(JSON.stringify(stats), new RegExp(SECRET), "app secret must not reach the loopback");
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

test("FEISHU_REMOTE=1 queues busy phone messages with acknowledgements, aborts on stop, and drains the queue in order", async () => {
  const slowModel: ModelResponder = (lastUser) => ({
    delayMs: lastUser.includes("SLOW") ? 4000 : 0,
    sse: sse(`PTY-PONG:${lastUser}`),
  });
  const f = await fixture(slowModel, [
    { delayMs: 400, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "slow-1", messageType: "text", text: "SLOW-phone-1" } },
    { delayMs: 650, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "fast-2", messageType: "text", text: "followup-2" } },
    { delayMs: 700, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "fast-3", messageType: "text", text: "followup-3" } },
    { delayMs: 800, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "stop-4", messageType: "text", text: "stop" } },
  ]);
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

test("tool execution shows a transient friendly status — even when the card is still opening — and clears it before finalizing", async () => {
  const toolResponses = [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "status-tool-1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf RAW_TOOL_OUTPUT_SHOULD_STAY_LOCAL" }) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
    sse("TOOL-STATUS-DONE"),
  ];
  const f = await fixture(() => ({ sse: toolResponses.shift() ?? sse("NO-RESPONSE") }), [
    { delayMs: 100, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "status-1", messageType: "text", text: "run-tool" } },
  ], { cardOpenDelayMs: 150 });
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      { wait: "TOOL-STATUS-DONE", send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    const cardId = stats.cards.opened[0]?.cardId;
    const cardStatuses = stats.cards.statuses.filter((status) => status.cardId === cardId);
    const statusTexts = cardStatuses.map((status) => status.text);
    assert.ok(statusTexts.some((text) => /command|bash/i.test(text) && /[\u{1F300}-\u{1FAFF}]/u.test(text)), `tool status must land on the card even while it was still opening: ${JSON.stringify(statusTexts)}`);
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
    assert.ok(cleared.length, "the status line is cleared eventually");
    assert.ok(!stats.cards.statuses.some((status) => status.text === ""), "empty content must never be sent to CardKit");
    for (const clear of cleared) assert.ok(firstAppendAt - clear.at < 200, `status must clear when visible text starts, not at message_start: clear=${clear.at} firstAppend=${firstAppendAt}`);
    assert.doesNotMatch(JSON.stringify(stats.cards.appends), /THOUGHT-/, "reasoning never reaches the card");
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});
