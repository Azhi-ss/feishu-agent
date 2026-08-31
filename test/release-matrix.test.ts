import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("release guide documents externally observable scope and boundaries", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  for (const phrase of ["feishu init", "Interactive Feishu Runtime", "Print-mode", "feishu install", "feishu skills sync", "--lark-profile", "Long-term Memory", "High-risk Approval", "not a Pi fork", "not an OS sandbox", "Raw tool output", "without copying tokens", "ordinary `pi`"]) assert.match(readme, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});
