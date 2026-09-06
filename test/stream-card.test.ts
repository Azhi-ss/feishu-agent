// Pure-function tests for the streaming-card state machine: throttle/coalesce
// flush decisions, reasoning-tag stripping, and final-reply sharding.
import assert from "node:assert/strict";
import test from "node:test";
import {
  shardText,
  shouldFlushStreamUpdate,
  STREAM_SIGNIFICANT_DELTA_CHARS,
  STREAM_UPDATE_THROTTLE_MS,
  visibleAssistantText,
} from "../packages/feishu-remote/extensions/stream-card.js";

test("the first visible text always flushes", () => {
  assert.equal(shouldFlushStreamUpdate("", "hello", 0), true);
  assert.equal(shouldFlushStreamUpdate("", "hello", 10_000), true);
});

test("a sentence/newline boundary forces a flush inside the throttle window", () => {
  for (const ending of ["\n", "。", "！", "？", "!", "?", "；", ";", "：", ":"]) {
    assert.equal(shouldFlushStreamUpdate("done", `done${ending}`, 1), true, JSON.stringify(ending));
  }
  assert.equal(shouldFlushStreamUpdate("done", "done.", 1), false, "a bare period is not a boundary (abbreviations, decimals)");
});

test("a significant delta forces a flush inside the throttle window", () => {
  const previous = "a".repeat(100);
  assert.equal(shouldFlushStreamUpdate(previous, previous + "b".repeat(STREAM_SIGNIFICANT_DELTA_CHARS), 1), true);
  assert.equal(shouldFlushStreamUpdate(previous, previous + "b".repeat(STREAM_SIGNIFICANT_DELTA_CHARS - 1), 1), false);
});

test("the throttle gap alone flushes at the minimum interval, coalescing faster updates", () => {
  assert.equal(shouldFlushStreamUpdate("done", "done-x", STREAM_UPDATE_THROTTLE_MS - 1), false);
  assert.equal(shouldFlushStreamUpdate("done", "done-x", STREAM_UPDATE_THROTTLE_MS), true);
  assert.equal(shouldFlushStreamUpdate("done", "done-xy", STREAM_UPDATE_THROTTLE_MS * 2), true);
});

test("visibleAssistantText keeps only visible text: thinking parts and commentary-phase text are stripped", () => {
  const commentary = JSON.stringify({ v: 1, id: "sig-1", phase: "commentary" });
  const finalAnswer = JSON.stringify({ v: 1, id: "sig-2", phase: "final_answer" });
  const parts = [
    { type: "thinking", thinking: "internal chain of thought" },
    { type: "text", text: "secret reasoning", textSignature: commentary },
    { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
    { type: "text", text: "Visible ", textSignature: finalAnswer },
    { type: "text", text: "answer." },
  ];
  assert.equal(visibleAssistantText(parts), "Visible answer.");
});

test("visibleAssistantText tolerates non-array, legacy, and malformed content", () => {
  assert.equal(visibleAssistantText(undefined), "");
  assert.equal(visibleAssistantText(null), "");
  assert.equal(visibleAssistantText("plain string"), "");
  assert.equal(visibleAssistantText([{ type: "text", text: "  hi  " }]), "hi");
  assert.equal(visibleAssistantText([{ type: "text", text: "ok", textSignature: "legacy-plain-id" }]), "ok");
  assert.equal(visibleAssistantText([{ type: "text", text: "kept", textSignature: "{not json" }]), "kept");
});

test("shardText passes short replies through as a single shard", () => {
  assert.deepEqual(shardText("short reply"), ["short reply"]);
});

test("shardText splits over-long replies at newline seams inside the envelope", () => {
  const limit = 100;
  const text = "x".repeat(60) + "\n" + "y".repeat(80) + "\n" + "z".repeat(40);
  const shards = shardText(text, limit);
  assert.ok(shards.length > 1);
  for (const shard of shards) assert.ok(shard.length <= limit, `shard too long: ${shard.length}`);
  assert.equal(shards.join(""), text, "shards must reassemble the original reply exactly");
});

test("shardText hard-cuts at the limit when there is no newline seam", () => {
  assert.deepEqual(shardText("x".repeat(250), 100), ["x".repeat(100), "x".repeat(100), "x".repeat(50)]);
});

test("shardText shards by UTF-8 bytes, so CJK replies fit the ~30KB envelope", () => {
  const chunk = "中文回复。";
  const text = chunk.repeat(300); // 1500 chars, 4500 bytes
  const shards = shardText(text, 1000);
  assert.ok(shards.length > 1);
  for (const shard of shards) assert.ok(Buffer.byteLength(shard, "utf8") <= 1000, `shard too heavy: ${Buffer.byteLength(shard, "utf8")} bytes`);
  assert.equal(shards.join(""), text);
});
