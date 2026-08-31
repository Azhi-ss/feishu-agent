import assert from "node:assert/strict";
import test from "node:test";
import { prohibitedCommand } from "../src/command-policy.js";

test("command policy rejects exact prohibited commands only", () => {
  for (const input of ["/share", "/import file", "/login provider", "/logout"]) assert(prohibitedCommand(input));
  for (const input of ["Explain why /share is disabled", "/export x", "/new", "/resume", "/tree", "/fork", "/clone", "/compact", "/sharing"]) assert.equal(prohibitedCommand(input), undefined);
});
