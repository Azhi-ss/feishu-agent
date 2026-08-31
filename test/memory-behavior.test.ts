import assert from "node:assert/strict";
process.env.MEM0_TELEMETRY = "false";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { memoryConfig, writeMemoryConfig } from "../src/memory.js";
import { withCompatibilityHome } from "../src/compatibility-home.js";

test("Mem0 config enforces stable Feishu project capture without secrets", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-memory-")); const agent = join(root, ".feishu-agent");
  const config = memoryConfig("alice");
  assert.deepEqual(config, { userId: "feishu:alice", autoCapture: true, defaultScope: "project", contextInjection: true, dream: { enabled: true, auto: true } });
  const path = writeMemoryConfig(agent, "alice");
  const saved = readFileSync(path, "utf8");
  assert.doesNotMatch(saved, /apiKey|MEM0_API_KEY/);
  process.env.MEM0_USER_ID = "attacker";
  await withCompatibilityHome(root, agent, async () => {
    const plugin = await import("@mem0/pi-agent-plugin");
    const extracted = plugin.extractConversation([{ role: "user", content: "question" }, { role: "toolResult", content: "secret tool output" }, { role: "assistant", content: [{ type: "text", text: "answer" }] }]);
    assert.deepEqual(extracted, [{ role: "user", content: "question" }, { role: "assistant", content: "answer" }]);
    assert.deepEqual(plugin.resolveAddParams("project", { userId: config.userId, appId: "project-key", runId: "run" }), { userId: "feishu:alice", appId: "project-key" });
  });
  assert.equal(process.env.MEM0_TELEMETRY, "false");
});
