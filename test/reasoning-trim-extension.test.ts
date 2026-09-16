import assert from "node:assert/strict";
import test from "node:test";
import { reasoningTrimExtension } from "../src/reasoning-trim-extension.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (event: any, ctx?: unknown) => any;

function loadExtension() {
  const handlers = new Map<string, Handler[]>();
  const warnings: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => { warnings.push(String(chunk).trimEnd()); return true; }) as typeof process.stderr.write;
  const fake = {
    on(event: string, handler: Handler): void {
      const existing = handlers.get(event) ?? [];
      handlers.set(event, [...existing, handler]);
    },
  } as unknown as ExtensionAPI;
  reasoningTrimExtension()(fake);
  return {
    handlers,
    warnings,
    restore() { process.stderr.write = originalWrite; },
  };
}

test("context hook returns a filtered view with final-answer reasoning removed and answers kept", async () => {
  const harness = loadExtension();
  try {
    const handler = harness.handlers.get("context")![0];
    const messages = [
      { role: "user", content: "q" },
      { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "SECRET" }, { type: "text", text: "ANSWER" }] },
    ];
    const result = await handler({ messages });
    assert.deepEqual(result.messages[1].content, [{ type: "text", text: "ANSWER" }]);
    // Incoming list and message objects stay untouched.
    assert.deepEqual(messages[1].content[0], { type: "thinking", thinking: "SECRET" });
  } finally { harness.restore(); }
});

test("context hook atomic fallback: an unexpected failure keeps the exact incoming view and logs a content-free diagnostic", async () => {
  const harness = loadExtension();
  try {
    const handler = harness.handlers.get("context")![0];
    // Property access that throws inside the pure filter simulates a malformed
    // message tree (compute phase failure). No half-trimmed list may be returned.
    const incoming = [{ role: "assistant", get stopReason() { throw new Error("boom"); } }];
    const result = await handler({ messages: incoming });
    assert.equal(result, undefined, "fallback signals Pi to keep the incoming original context");
    assert.equal(harness.warnings.length, 1);
    assert.match(harness.warnings[0], /Replay reasoning trim unavailable/);
    assert.doesNotMatch(harness.warnings[0], /boom|SECRET|reasoning content/i);
  } finally { harness.restore(); }
});

test("compaction hook trims messagesToSummarize and the split-turn prefix in place", async () => {
  const harness = loadExtension();
  try {
    const handler = harness.handlers.get("session_before_compact")![0];
    const event = {
      preparation: {
        messagesToSummarize: [{ role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "OLD-REASONING" }, { type: "text", text: "OLD-ANSWER" }] }],
        turnPrefixMessages: [{ role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "PREFIX-REASONING" }, { type: "text", text: "PREFIX-ANSWER" }] }],
      },
    };
    const result = await handler(event);
    assert.equal(result, undefined);
    assert.deepEqual(event.preparation.messagesToSummarize[0].content, [{ type: "text", text: "OLD-ANSWER" }]);
    assert.deepEqual(event.preparation.turnPrefixMessages[0].content, [{ type: "text", text: "PREFIX-ANSWER" }]);
  } finally { harness.restore(); }
});

test("compaction hook atomic failure: error during prefix trim leaves messagesToSummarize unmutated", async () => {
  const harness = loadExtension();
  try {
    const handler = harness.handlers.get("session_before_compact")![0];
    const initialSummarize = [{ role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "OLD-REASONING" }, { type: "text", text: "OLD-ANSWER" }] }];
    const throwingPrefix = [{ role: "assistant", get stopReason() { throw new Error("prefix-boom"); } }];
    const event = {
      preparation: {
        messagesToSummarize: initialSummarize,
        turnPrefixMessages: throwingPrefix,
      },
    };
    await handler(event);
    assert.equal(event.preparation.messagesToSummarize, initialSummarize, "must not partially mutate messagesToSummarize");
    assert.equal(harness.warnings.length, 1);
    assert.doesNotMatch(harness.warnings[0], /prefix-boom/);
    assert.match(harness.warnings[0], /Warning: Replay reasoning trim unavailable/);
  } finally { harness.restore(); }
});

test("branch-tree hook atomic failure: mid-array failure leaves all original entries untouched", async () => {
  const harness = loadExtension();
  try {
    const handler = harness.handlers.get("session_before_tree")![0];
    const entry1 = { type: "message", id: "e1", message: { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "THINK-1" }, { type: "text", text: "ANS-1" }] } };
    const entry2 = { type: "message", id: "e2", message: { role: "assistant", get stopReason() { throw new Error("entry2-boom"); } } };
    const entries = [entry1, entry2];
    const event = { preparation: { entriesToSummarize: entries } };
    await handler(event);
    assert.equal(entries[0], entry1, "entry1 must not be replaced when subsequent entry fails");
    assert.equal(entries[1], entry2);
    assert.equal(harness.warnings.length, 1);
    assert.doesNotMatch(harness.warnings[0], /entry2-boom/);
  } finally { harness.restore(); }
});

test("branch-tree hook replaces only the view of message entries, preserving answer text", async () => {
  const harness = loadExtension();
  try {
    const handler = harness.handlers.get("session_before_tree")![0];
    const originalMessage = { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "BRANCH-REASONING" }, { type: "text", text: "BRANCH-ANSWER" }] };
    const entry = { type: "message", id: "e1", message: originalMessage };
    const labelEntry = { type: "label", id: "e2" };
    const event = { preparation: { entriesToSummarize: [entry, labelEntry] } };
    const result = await handler(event);
    assert.equal(result, undefined);
    const viewed = (event.preparation.entriesToSummarize as Array<{ message?: { content: unknown[] } }>)[0];
    assert.notEqual(viewed, entry, "summary view uses a cloned entry");
    assert.deepEqual(viewed.message!.content, [{ type: "text", text: "BRANCH-ANSWER" }]);
    assert.deepEqual(originalMessage.content[0], { type: "thinking", thinking: "BRANCH-REASONING" }, "original session entry unchanged");
    assert.equal(event.preparation.entriesToSummarize[1], labelEntry);
  } finally { harness.restore(); }
});

test("branch-tree hook failure leaves the entries untouched", async () => {
  const harness = loadExtension();
  try {
    const handler = harness.handlers.get("session_before_tree")![0];
    const event = { preparation: { entriesToSummarize: "not-an-array" } };
    await handler(event);
    assert.equal(event.preparation.entriesToSummarize, "not-an-array");
    assert.equal(harness.warnings.length, 1);
  } finally { harness.restore(); }
});
