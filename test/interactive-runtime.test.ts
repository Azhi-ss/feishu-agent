import assert from "node:assert/strict";
import test from "node:test";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { runInteractive } from "../src/runtime.js";

test("interactive runtime is composed from Pi public TUI API", () => {
  assert.equal(typeof InteractiveMode, "function");
  assert.equal(typeof runInteractive, "function");
});
