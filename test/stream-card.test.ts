// Pure-function tests for the streaming-card state machine: throttle/coalesce
// flush decisions, reasoning-tag stripping, and final-reply sharding.
import assert from "node:assert/strict";
import test from "node:test";
import {
  shardText,
  shouldFlushStreamUpdate,
  STREAM_SIGNIFICANT_DELTA_CHARS,
  STREAM_UPDATE_THROTTLE_MS,
  StreamCardSession,
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

test("throttle starts at actual append after a queued status request, not at update", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const writes: Array<{ text: string; at: number }> = [];
  const session = new StreamCardSession("delayed-status", {
    setStatus: () => blocked,
    append: async (_id, text) => { writes.push({ text, at: Date.now() }); },
    closeCard: async () => {},
  }, error => { throw error; });
  const drain = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    session.setStatus("working");
    session.update("a");
    await drain();
    assert.equal(writes.length, 0);
    t.mock.timers.tick(200);
    release();
    await drain();
    assert.deepEqual(writes, [{ text: "a", at: 1200 }]);
    session.update("ab");
    await drain();
    assert.equal(writes.length, 1, "small delta must not bypass throttle after queue delay");
    t.mock.timers.tick(STREAM_UPDATE_THROTTLE_MS - 1);
    await drain();
    assert.equal(writes.length, 1);
    t.mock.timers.tick(1);
    await drain();
    assert.deepEqual(writes[1], { text: "ab", at: 1360 });
  } finally {
    release();
    await session.finalize("ab");
  }
});

test("queued flushes recheck coalesced text and preserve forced updates and final close", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const writes: Array<{ text: string; at: number }> = [];
  const closes: string[] = [];
  const session = new StreamCardSession("slow-append", {
    setStatus: async () => {},
    append: async (_id, text) => {
      writes.push({ text, at: Date.now() });
      if (writes.length === 1) await blocked;
    },
    closeCard: async (_id, text) => { closes.push(text); },
  }, error => { throw error; });
  const drain = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    session.update("a");
    await drain();
    t.mock.timers.tick(200);
    session.update("ab");
    session.update("abc");
    release();
    await drain();
    assert.deepEqual(writes, [{ text: "a", at: 1000 }, { text: "abc", at: 1200 }]);
    session.update("abcd");
    await drain();
    assert.equal(writes.length, 2);
    const significant = "abcd" + "x".repeat(STREAM_SIGNIFICANT_DELTA_CHARS);
    session.update(significant);
    await drain();
    assert.deepEqual(writes.at(-1), { text: significant, at: 1200 });
    session.update(significant + "。");
    await drain();
    assert.deepEqual(writes.at(-1), { text: significant + "。", at: 1200 });
    session.update(significant + "。tail");
    await drain();
    await session.finalize(significant + "。tail");
    t.mock.timers.tick(1000);
    await drain();
    assert.equal(writes.length, 4, "no pending timer writes after finalization");
    assert.deepEqual(closes, [significant + "。tail"]);
  } finally {
    release();
    await session.finalize("cleanup");
  }
});

function recordingOps(): {
  ops: ConstructorParameters<typeof StreamCardSession>[1];
  statusWrites: string[];
  appendWrites: string[];
  fail: ((error: Error) => void) | undefined;
} {
  const statusWrites: string[] = [];
  const appendWrites: string[] = [];
  const rec = {
    statusWrites,
    appendWrites,
    fail: undefined as ((error: Error) => void) | undefined,
    ops: {
      append: async (_id: string, text: string) => { appendWrites.push(text); },
      setStatus: async (_id: string, text: string) => { statusWrites.push(text); },
      closeCard: async () => {},
    },
  };
  return rec;
}

test("clearing the status strip sends a space, never empty content (CardKit rejects empty with HTTP 400 / 99992402)", async () => {
  const rec = recordingOps();
  const session = new StreamCardSession("card-1", rec.ops, () => { throw new Error("status writes must not fail"); });
  session.setStatus("🛠️ Running bash");
  session.setStatus(""); // first visible assistant text clears the strip
  await new Promise((done) => setTimeout(done, 0));
  assert.deepEqual(rec.statusWrites, ["🛠️ Running bash", " "]);
});

test("finalize also clears a lingering status strip with a space, not empty content", async () => {
  const rec = recordingOps();
  const session = new StreamCardSession("card-2", rec.ops, () => {});
  session.setStatus("🛠️ Running bash");
  await session.finalize("the answer");
  assert.ok(rec.statusWrites.includes(" "));
  assert.ok(!rec.statusWrites.some((text) => text === ""));
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
