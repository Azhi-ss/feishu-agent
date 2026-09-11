import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "../src/reasoning-trim.js";
import { isTrimmableFinalAnswer, trimFinalAnswerReasoning, trimReplayedReasoning } from "../src/reasoning-trim.js";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistant(content: unknown[], stopReason: string, extra: Record<string, unknown> = {}): AgentMessage {
  return { role: "assistant", api: "openai-completions", provider: "fake", model: "m", timestamp: 1, stopReason, usage, content, ...extra } as unknown as AgentMessage;
}

const thinking = (text: string, extra: Record<string, unknown> = {}) => ({ type: "thinking", thinking: text, ...extra });
const text = (body: string) => ({ type: "text", text: body });
const toolCall = (id: string) => ({ type: "toolCall", id, name: "bash", arguments: { command: "echo" } });
const user = (body: string) => ({ role: "user", content: [{ type: "text", text: body }], timestamp: 1 }) as unknown as AgentMessage;

test("trims only plain reasoning from a normally completed text-only final answer", () => {
  const message = assistant([thinking("SECRET-REASONING"), text("ANSWER-TEXT")], "stop");
  assert.equal(isTrimmableFinalAnswer(message), true);
  const trimmed = trimFinalAnswerReasoning(message);
  assert.notEqual(trimmed, message, "eligible message is cloned");
  assert.deepEqual((trimmed as { content: unknown[] }).content, [text("ANSWER-TEXT")]);
  // The original message and its reasoning stay intact.
  assert.deepEqual((message as { content: unknown[] }).content[0], thinking("SECRET-REASONING"));
});

test("applies the same rule across a mixed history view", () => {
  const finalAnswer = assistant([thinking("FINAL-REASONING"), text("FINAL-ANSWER")], "stop");
  const toolStep = assistant([thinking("TOOL-REASONING"), toolCall("call-1")], "toolUse");
  const toolResult = { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [text("hi")], isError: false, timestamp: 1 } as unknown as AgentMessage;
  const afterTools = assistant([text("AFTER-TOOLS-ANSWER")], "stop");
  const view = trimReplayedReasoning([user("q1"), finalAnswer, user("q2"), toolStep, toolResult, afterTools]);
  assert.deepEqual((view[1] as { content: unknown[] }).content, [text("FINAL-ANSWER")]);
  assert.equal(view[3], toolStep, "tool-step reasoning retained by reference");
  assert.deepEqual((view[3] as { content: unknown[] }).content, [thinking("TOOL-REASONING"), toolCall("call-1")]);
  assert.equal(view[4], toolResult);
  assert.equal(view[5], afterTools, "answer with no reasoning unchanged");
});

const nonCandidates: Array<[string, AgentMessage]> = [
  ["toolUse stop reason", assistant([thinking("r"), toolCall("c1")], "toolUse")],
  ["in-progress pending", assistant([thinking("r"), text("a")], "pending")],
  ["aborted", assistant([thinking("r"), text("a")], "aborted")],
  ["error", assistant([thinking("r"), text("a")], "error")],
  ["truncated length", assistant([thinking("r"), text("a")], "length")],
  ["deferred", assistant([thinking("r"), text("a")], "deferred")],
  ["reasoning without final answer text", assistant([thinking("r")], "stop")],
  ["empty final answer text", assistant([thinking("r"), text("   ")], "stop")],
  ["empty reasoning", assistant([thinking(" "), text("a")], "stop")],
  ["tool call after reasoning despite stop", assistant([thinking("r"), text("a"), toolCall("c2")], "stop")],
  ["signed reasoning chain", assistant([thinking("r", { thinkingSignature: "sig" }), text("a")], "stop")],
  ["redacted encrypted reasoning", assistant([thinking("r", { redacted: true, thinkingSignature: "opaque" }), text("a")], "stop")],
  ["unknown adaptor marker on reasoning", assistant([thinking("r", { adapterMarker: 1 }), text("a")], "stop")],
  ["unknown block type", assistant([thinking("r"), text("a"), { type: "image" }], "stop")],
];

for (const [label, message] of nonCandidates) {
  test(`retains non-candidate: ${label}`, () => {
    assert.equal(isTrimmableFinalAnswer(message), false);
    assert.equal(trimFinalAnswerReasoning(message), message);
  });
}

test("user and toolResult messages are never candidates", () => {
  const question = user("q");
  const result = { role: "toolResult", toolCallId: "c", toolName: "bash", content: [text("x")], isError: false, timestamp: 1 } as unknown as AgentMessage;
  assert.equal(trimFinalAnswerReasoning(question), question);
  assert.equal(trimFinalAnswerReasoning(result), result);
});

test("never throws on structurally unexpected input and preserves every original message", () => {
  // Controlled-failure fixture: trimReplayedReasoning must compute first and,
  // on an unexpected structure, either leave that message alone rather than
  // producing a half-trimmed list. The extension layer adds the atomic
  // fallback to the exact incoming list (reasoning-trim-extension behavior is
  // covered by the CLI seam tests).
  const malformed = { role: "assistant", stopReason: "stop", content: "not-an-array" } as unknown as AgentMessage;
  assert.equal(isTrimmableFinalAnswer(malformed), false);
  assert.equal(trimFinalAnswerReasoning(malformed), malformed);
});

test("multiple plain reasoning blocks on a final answer are all removed, answer kept", () => {
  const message = assistant([thinking("one"), thinking("two"), text("answer")], "stop");
  assert.deepEqual((trimFinalAnswerReasoning(message) as { content: unknown[] }).content, [text("answer")]);
});
