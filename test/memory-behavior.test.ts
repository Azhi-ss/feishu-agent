import assert from "node:assert/strict";
process.env.MEM0_TELEMETRY = "false";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { memoryConfig, memoryRuntime, writeMemoryConfig } from "../src/memory.js";
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

test("Mem0 runtime resists external identity, uses collision-proof project key, captures text only, and degrades without secrets", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-memory-runtime-"));
  const agent = join(root, ".feishu-agent");
  writeMemoryConfig(agent, "alice");
  process.env.MEM0_API_KEY = "top-secret-key";
  process.env.MEM0_USER_ID = "attacker";
  const calls: any[] = [];
  const client = {
    ping: async () => {}, search: async () => ({ results: [] }), getAll: async () => ({ results: [] }), update: async () => ({}), delete: async () => ({}), deleteAll: async () => ({}),
    add: async (...args: unknown[]) => { calls.push(args); },
  };
  const runtime = await memoryRuntime(agent, "repo-abc123", () => client);
  assert.equal(process.env.MEM0_USER_ID, "attacker");
  assert(runtime.extension);
  const handlers = new Map<string, Function[]>();
  runtime.extension!({
    on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: () => {}, registerCommand: () => {},
  } as never);
  await handlers.get("agent_end")![0]({ messages: [{ role: "user", content: "question" }, { role: "toolResult", content: "secret tool output" }, { role: "assistant", content: [{ type: "text", text: "answer" }] }] });
  assert.deepEqual(calls[0][0], [{ role: "user", content: "question" }, { role: "assistant", content: "answer" }]);
  assert.deepEqual(calls[0][1], { userId: "feishu:alice", appId: "repo-abc123" });
  const failingClient = { ...client, search: async () => { throw new Error("top-secret-key recall failed"); } };
  const failingRuntime = await memoryRuntime(agent, "repo-abc123", () => failingClient);
  const failingHandlers = new Map<string, Function[]>();
  failingRuntime.extension!({ on: (name: string, handler: Function) => failingHandlers.set(name, [...(failingHandlers.get(name) ?? []), handler]), registerTool: () => {}, registerCommand: () => {} } as never);
  await failingHandlers.get("before_agent_start")![0]({ prompt: "recall", systemPrompt: "base" });
  const before = calls.length;
  await failingHandlers.get("agent_end")![0]({ messages: [{ role: "user", content: "must not capture after degradation" }] });
  assert.equal(calls.length, before);
  const degraded = await memoryRuntime(agent, "repo-abc123", () => ({ ...client, ping: async () => { throw new Error("top-secret-key failed"); } }));
  assert.equal(degraded.extension, undefined);
  assert.doesNotMatch(degraded.warning!, /top-secret-key/);
  assert.match(degraded.warning!, /REDACTED/);
});
