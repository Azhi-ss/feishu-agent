import assert from "node:assert/strict";
import test from "node:test";
import { fallbackReaction, parseReactionChoice, REACTION_PROMPT_FOR_MODEL } from "../packages/feishu-remote/extensions/reaction-selector.js";

test("reaction selector accepts supported Feishu emoji types and bounds the opening", () => {
  const choice = parseReactionChoice('{"emoji_type":"PARTY","opening":"小欠马上来处理这个问题～这是多余内容"}');
  assert.equal(choice.emojiType, "PARTY");
  assert.equal(choice.opening, "小欠马上来处理这个问题～这是多余");
});

test("reaction selector falls back safely for invalid or malformed model output", () => {
  assert.deepEqual(parseReactionChoice('{"emoji_type":"<script>","opening":"bad"}'), { emojiType: fallbackReaction.emojiType, opening: "bad" });
  assert.deepEqual(parseReactionChoice("not json"), fallbackReaction);
  assert.match(REACTION_PROMPT_FOR_MODEL, /GeneralWorkFromHome/);
});
