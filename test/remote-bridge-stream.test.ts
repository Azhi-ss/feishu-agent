import { existsSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import type { ModelResponder } from "./helpers/remote-bridge-fixture.js";
import { STREAM_CARD_TEXT_LIMIT_BYTES } from "../packages/feishu-remote/extensions/stream-card.js";
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

test("a sustained gateway outage reconnects once, resumes phone delivery, and reports a single recovery", async () => {
  const f = await fixture(echoModel, [
    { delayMs: 5500, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "reconnect-1", messageType: "text", text: "after-reconnect" } },
  ], { failPollsAfterFirst: 3 });
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      { wait: "PTY-PONG:after-reconnect", send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Remote bridge reconnected/);
    assert.ok((result.output.match(/connection interrupted/g) ?? []).length === 1, `a sustained outage warns once: ${result.output.match(/connection interrupted/g)?.length ?? 0} warnings`);
    const stats = await f.feishu.stats();
    assert.ok(stats.polls >= 5, JSON.stringify(stats));
    assert.equal(stats.cards.closes[0]?.text, "PTY-PONG:after-reconnect");
    assert.doesNotMatch(result.output, new RegExp(SECRET));
    assert.doesNotMatch(JSON.stringify(stats), new RegExp(SECRET));
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("a hard gateway connection failure warns without a false reconnecting notice and without disabling local work", async () => {
  const f = await fixture(echoModel, []);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: "http://127.0.0.1:1" }), [
      { wait: "fake-model", send: "/remote start\r" },
      { wait: "Remote bridge could not connect", send: "local-work-still-works\r" },
      { wait: "PTY-PONG:local-work-still-works", send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Remote bridge could not connect/);
    assert.doesNotMatch(result.output, /reconnect/i, "initial-connect failure never runs the retry loop and must not claim to be reconnecting");
    assert.match(result.output, /PTY-PONG:local-work-still-works/);
    assert.doesNotMatch(result.output, new RegExp(SECRET), "app secret must not reach TUI output");
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("High-risk Approval guard still applies to phone-originated turns", async () => {
  const exactCommand = "lark-cli doc delete doc-1 --as user --yes";
  const responses = [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "guard-1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: exactCommand }) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
    sse("GUARD-DONE"),
  ];
  const guardedModel: ModelResponder = () => ({ sse: responses.shift() ?? sse("NO-RESPONSES-LEFT") });
  const f = await fixture(guardedModel, [
    { delayMs: 400, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "guard-1", messageType: "text", text: "整理一下文档" } },
  ]);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      { wait: "整理一下文档", send: "" },
      { wait: "Blocked lark-cli --yes", send: "" },
      { wait: "GUARD-DONE", send: "/quit\r" },
    ], 60, f.timeoutProgress);
    assert.equal(result.code, 0, result.output);
    const calls = existsSync(f.larkTrace) ? readFileSync(f.larkTrace, "utf8").trim().split("\n").filter((line) => !line.endsWith("--version") && !line.endsWith("skills list --json")) : [];
    assert.deepEqual(calls, [], "blocked command must never reach lark-cli");
    const stats = await f.feishu.stats();
    assert.equal(stats.cards.closes.length, 1, JSON.stringify(stats.cards.closes));
    assert.equal(stats.cards.closes[0].text, "GUARD-DONE");
    assert.doesNotMatch(result.output, new RegExp(SECRET));
    assert.doesNotMatch(JSON.stringify(stats), new RegExp(SECRET));
    for (const session of f.sessionFiles()) assert.doesNotMatch(session, new RegExp(SECRET));
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("a phone turn streams assistant text into ONE card in segments, finalizes it with the complete reply, and excludes reasoning", async () => {
  const textChunks: string[] = [];
  for (let i = 0; i < 24; i++) textChunks.push(`stream-chunk-${i}-`);
  const reply = textChunks.join("") + "。";
  const stream: Array<{ line: string; delayMs: number }> = [];
  for (let i = 0; i < textChunks.length; i++) {
    if (i % 4 === 0) stream.push({ line: sseDelta({ reasoning_content: `THOUGHT-${i}-hidden` }), delayMs: 20 });
    stream.push({ line: sseDelta({ content: textChunks[i] }), delayMs: 20 });
  }
  stream.push({ line: sseDelta({ content: "。" }), delayMs: 10 });
  stream.push({ line: sseDone(), delayMs: 0 });
  const streamingModel: ModelResponder = () => ({ stream });
  const f = await fixture(streamingModel, [
    { delayMs: 400, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "stream-1", messageType: "text", text: "stream-for-me" } },
  ]);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      { wait: "stream-chunk-0-", send: "" },
      { wait: "stream-chunk-23-。", send: "/remote status\r" },
      { wait: "Remote bridge: connected", send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    assert.equal(stats.cards.opened.length, 1, JSON.stringify(stats.cards.opened));
    assert.equal(stats.cards.opened[0].chatId, "oc_phone");
    const appends = stats.cards.appends;
    assert.ok(appends.length >= 2 && appends.length <= 20, `segmented but coalesced arrival: ${appends.length} appends`);
    for (let i = 0; i < appends.length; i++) {
      assert.ok(reply.startsWith(appends[i].text), `append ${i} must be a prefix snapshot of the reply: ${JSON.stringify(appends[i].text)}`);
      assert.equal(appends[i].sequence, i + 1, "monotonic sequence per write");
      assert.doesNotMatch(appends[i].text, /THOUGHT-/, "reasoning must never reach the card");
    }
    assert.equal(new Set(appends.map((append) => append.uuid)).size, appends.length, "unique id per write");
    for (let i = 1; i < appends.length; i++) {
      const gap = appends[i].at - appends[i - 1].at;
      if (gap < 140) {
        const forced = /[\n。！？!?；;：:]$/.test(appends[i].text) || appends[i].text.length - appends[i - 1].text.length >= 18;
        assert.ok(forced, `writes ${i - 1}->${i} were ${gap}ms apart without a boundary or delta force; snapshots=${JSON.stringify(appends.slice(0, 20).map((append, index) => ({
          sequence: append.sequence,
          elapsedMs: append.at - appends[0].at,
          gapMs: index ? append.at - appends[index - 1].at : null,
          length: append.text.length,
          delta: index ? append.text.length - appends[index - 1].text.length : null,
          boundary: /[\n。！？!?；;：:]$/.test(append.text),
        })))}`);
      }
    }
    assert.equal(stats.cards.closes.length, 1, JSON.stringify(stats.cards.closes));
    assert.equal(stats.cards.closes[0].text, reply, "the final close is authoritative: complete reply");
    assert.equal(stats.sends.length, 0, "no plain-text fallback when the card works");
    assert.doesNotMatch(JSON.stringify(stats), new RegExp(SECRET));
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("over-long final replies are delivered completely (sharded), not truncated", async () => {
  const reply = "LONG-REPLY:" + "A".repeat(30_150) + "LONG-REPLY-END-MARKER";
  const longModel: ModelResponder = () => ({ sse: sse(reply) });
  const f = await fixture(longModel, [
    { delayMs: 400, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "long-1", messageType: "text", text: "long-answer-please" } },
  ]);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      { wait: "LONG-REPLY-END-MARKER", send: "/remote status\r" },
      { wait: "Remote bridge: connected", send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    const stats = await f.feishu.stats();
    assert.equal(stats.cards.opened.length, 1);
    assert.equal(stats.cards.closes.length, 1, JSON.stringify(stats.cards.closes));
    assert.ok(stats.cards.closes[0].text.length <= STREAM_CARD_TEXT_LIMIT_BYTES, `first shard must fit one card envelope: ${stats.cards.closes[0].text.length}`);
    const delivered = stats.cards.closes[0].text + stats.sends.map((send) => send.text).join("");
    assert.equal(delivered, reply, "sharded delivery must reassemble the complete reply");
    assert.equal(stats.sends.length, 1, JSON.stringify(stats.sends));
    assert.ok(Buffer.byteLength(stats.sends[0].text, "utf8") <= STREAM_CARD_TEXT_LIMIT_BYTES);
    assert.doesNotMatch(JSON.stringify(stats), new RegExp(SECRET));
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});
