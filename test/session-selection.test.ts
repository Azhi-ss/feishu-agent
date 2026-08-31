import assert from "node:assert/strict";
import test from "node:test";
import { runtimeHostSwitchOverride } from "../src/runtime.js";

test("host-owned session selection always overrides the historical cwd", async () => {
  const calls: unknown[][] = [];
  await runtimeHostSwitchOverride({ switchSession: async (...args: unknown[]) => { calls.push(args); return { cancelled: false }; } } as never, "/sessions/selected.jsonl", "/current/launch");
  assert.deepEqual(calls, [["/sessions/selected.jsonl", { cwdOverride: "/current/launch" }]]);
});
