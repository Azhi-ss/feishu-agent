import assert from "node:assert/strict";
import test from "node:test";
import { oneCardNoExtraViolations } from "./helpers/lark-chat-page.js";
import type { ChatMessage } from "./helpers/lark-chat-page.js";

// The live e2e asserts #65's "normal path has exactly one card, one close and no extra
// plain message" against a real chat; these synthetic pages keep that assertion honest
// offline. Pages are newest-first, as `lark-cli im +chat-messages-list --order desc` returns them.
const app = (id: string, type: string): ChatMessage => ({ message_id: id, msg_type: type, sender: { sender_type: "app" } });
const user = (id: string): ChatMessage => ({ message_id: id, msg_type: "text", sender: { sender_type: "user" } });

test("a clean turn has no violations", () => {
  assert.deepEqual(oneCardNoExtraViolations([app("c1", "interactive"), user("u1"), user("b0")], "b0", "c1"), []);
});

test("a plain message after the card is a violation", () => {
  const violations = oneCardNoExtraViolations([app("t1", "text"), app("c1", "interactive"), user("u1"), user("b0")], "b0", "c1");
  assert.equal(violations.length, 1);
  assert.match(violations[0], /extra message\(s\) after the card: text/);
});

test("a second card in the same turn is a violation", () => {
  const violations = oneCardNoExtraViolations([app("c2", "interactive"), app("c1", "interactive"), user("u1"), user("b0")], "b0", "c1");
  assert.match(violations[0], /extra message\(s\) after the card: interactive/);
});

test("a plain message between the baseline and the card is a violation", () => {
  // newest-first, so the card comes before the older plain message in the report
  const violations = oneCardNoExtraViolations([app("c1", "interactive"), app("t0", "text"), user("u1"), user("b0")], "b0", "c1");
  assert.match(violations[0], /bot messages were \[interactive, text\]/);
});

test("a card left over from an earlier run is not this turn's card", () => {
  assert.deepEqual(oneCardNoExtraViolations([app("old", "interactive"), user("b0")], "b0", "c1"), ["the new card c1 is not in the newest messages"]);
});

test("an unrelated user message after the card is not a violation", () => {
  assert.deepEqual(oneCardNoExtraViolations([user("u2"), app("c1", "interactive"), user("u1"), user("b0")], "b0", "c1"), []);
});

test("a baseline that scrolled off the page weakens the count check instead of failing", () => {
  assert.deepEqual(oneCardNoExtraViolations([app("c1", "interactive"), user("u1")], "b0", "c1"), []);
  assert.match(oneCardNoExtraViolations([app("t1", "text"), app("c1", "interactive"), user("u1")], "b0", "c1")[0], /extra message\(s\) after the card/);
});
