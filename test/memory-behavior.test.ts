import assert from "node:assert/strict";
process.env.MEM0_TELEMETRY = "false";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { incrementSessionCount } from "@mem0/pi-agent-plugin";
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

test("installed Mem0 package factory loads under Compatibility Home without duplicate registrations", () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-memory-package-"));
  const agent = join(root, ".feishu-agent");
  mkdirSync(agent, { recursive: true });
  writeMemoryConfig(agent, "alice");
  writeFileSync(join(agent, "mem0-telemetry-id.json"), '{"anonymousId":"feishu-only"}');
  const script = String.raw`
    import assert from "node:assert/strict";
    import { existsSync, readFileSync } from "node:fs";
    import { join } from "node:path";
    import { pathToFileURL } from "node:url";
    import { withCompatibilityHome } from "./dist/src/compatibility-home.js";
    globalThis.fetch = async (input) => new Response(String(input).includes("/v1/ping") ? '{"status":"ok"}' : '{"results":[]}', { status: 200, headers: { "content-type": "application/json" } });
    const [root, agent, entry] = process.argv.slice(1);
    const commandNames = [];
    const toolNames = [];
    const handlers = new Map();
    const messages = [];
    const api = {
      on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
      registerCommand: (name, command) => { commandNames.push(name); api.commands.set(name, command); },
      registerTool: (tool) => toolNames.push(tool.name),
      sendMessage: (message) => messages.push(message),
      commands: new Map(),
    };
    await withCompatibilityHome(root, agent, async () => {
      const external = process.env.MEM0_USER_ID;
      delete process.env.MEM0_USER_ID;
      try { (await import(pathToFileURL(entry).href)).default(api); }
      finally { process.env.MEM0_USER_ID = external; }
    });
    assert.equal(process.env.HOME, root);
    assert.deepEqual(toolNames, ["mem0_memory"]);
    assert.equal(commandNames.length, new Set(commandNames).size);
    assert.equal(commandNames.length, 8);
    for (const name of ["session_start", "before_agent_start", "session_shutdown"]) assert.equal(handlers.get(name)?.length, 1);
    assert.equal(handlers.get("agent_end")?.length, 2);
    await handlers.get("session_start")[0]({}, { cwd: root, sessionManager: { getSessionFile: () => join(agent, "sessions", "factory.jsonl") } });
    assert(existsSync(join(agent, "mem0-dream-state.json")));
    await api.commands.get("mem0-status").handler("", { ui: { notify: () => {} } });
    assert(messages.some((message) => message.content.includes("User: feishu:alice")));
    await api.commands.get("mem0-dream").handler("", { ui: { notify: () => {} } });
    assert(existsSync(join(agent, "mem0-dream.lock")));
    assert.equal(readFileSync(join(agent, "mem0-telemetry-id.json"), "utf8"), '{"anonymousId":"feishu-only"}');
    for (const name of ["mem0-config.json", "mem0-dream-state.json", "mem0-dream.lock", "mem0-telemetry-id.json"]) assert.equal(existsSync(join(root, ".pi", "agent", name)), false);
    assert.equal(process.env.HOME, root);
    assert.equal(process.env.MEM0_USER_ID, "foreign-user");
    assert.equal(process.env.MEM0_TELEMETRY, "false");
  `;
  execFileSync(process.execPath, ["--input-type=module", "--eval", script, root, agent, join(process.cwd(), "node_modules", "@mem0", "pi-agent-plugin", "dist", "entry.js")], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: root, MEM0_API_KEY: "package-key", MEM0_USER_ID: "foreign-user", MEM0_TELEMETRY: "false" },
  });
});

test("Feishu memory composition owns manual Dream state under Feishu Agent Home", () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-memory-composed-"));
  const agent = join(root, ".feishu-agent");
  const script = String.raw`
    import assert from "node:assert/strict";
    import { existsSync } from "node:fs";
    import { join } from "node:path";
    import { memoryRuntime, writeMemoryConfig } from "./dist/src/memory.js";
    const [root, agent] = process.argv.slice(1);
    writeMemoryConfig(agent, "alice");
    const client = { ping: async () => {}, search: async () => ({ results: [] }), getAll: async () => ({ results: [] }), add: async () => [], update: async () => ({}), delete: async () => ({}), deleteAll: async () => ({}) };
    const runtime = await memoryRuntime(agent, "project-key", () => client);
    const commandNames = [];
    const commands = new Map();
    const handlers = new Map();
    const messages = [];
    runtime.extension({
      on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
      registerCommand: (name, command) => { commandNames.push(name); commands.set(name, command); },
      registerTool: () => {},
      sendMessage: (message) => messages.push(message),
    });
    assert.equal(commandNames.length, new Set(commandNames).size);
    assert.equal(commandNames.filter((name) => name === "mem0-dream").length, 1);
    await commands.get("mem0-status").handler("", { ui: { notify: () => {} } });
    assert(messages.some((message) => message.content.includes("User: feishu:alice")));
    await commands.get("mem0-dream").handler("", { ui: { notify: () => {} } });
    const stateDir = join(agent, "memory-state");
    assert(existsSync(join(stateDir, "mem0-dream.lock")));
    assert.equal(existsSync(join(root, ".pi", "agent", "mem0-dream.lock")), false);
    await handlers.get("before_agent_start")[0]({ prompt: "continue", systemPrompt: "base" });
    await handlers.get("agent_end")[0]({ messages: [{ role: "assistant", content: [{ type: "tool_use", name: "mem0_memory", input: { action: "delete" } }] }] });
    assert.equal(existsSync(join(stateDir, "mem0-dream.lock")), false);
    assert(existsSync(join(stateDir, "mem0-dream-state.json")));
  `;
  execFileSync(process.execPath, ["--input-type=module", "--eval", script, root, agent], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: root, MEM0_API_KEY: "composed-key", MEM0_USER_ID: "foreign-user", MEM0_TELEMETRY: "false" },
  });
});

test("explicit commands and tool actions are the only path to Global writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-memory-actions-"));
  const agent = join(root, ".feishu-agent");
  writeMemoryConfig(agent, "alice");
  process.env.MEM0_API_KEY = "actions-key";
  process.env.MEM0_USER_ID = "foreign-user";
  const additions: Array<[unknown, Record<string, unknown>]> = [];
  const client = {
    ping: async () => {}, search: async () => ({ results: [] }), getAll: async () => ({ results: [] }), update: async () => ({}), delete: async () => ({}), deleteAll: async () => ({}),
    add: async (messages: unknown, options: Record<string, unknown>) => { additions.push([messages, options]); return []; },
  };
  const runtime = await memoryRuntime(agent, "repo-collision-proof", () => client);
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  let tool: any;
  runtime.extension!({
    on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (registered: any) => { tool = registered; },
    registerCommand: (name: string, command: any) => commands.set(name, command),
    sendMessage: () => {},
  } as never);
  assert(tool);
  assert(commands.has("mem0-remember"));
  assert(commands.has("mem0-scope"));
  assert.equal(handlers.get("agent_end")?.length, 1);

  const commandContext = { ui: { notify: () => {}, confirm: async () => true, select: async () => undefined } } as never;
  await commands.get("mem0-remember").handler("project command", commandContext);
  await tool.execute("project-tool", { action: "add", content: "project tool" }, undefined, undefined, {});
  await commands.get("mem0-scope").handler("global", commandContext);
  await commands.get("mem0-remember").handler("global command", commandContext);
  await tool.execute("global-tool", { action: "add", content: "global tool", scope: "global" }, undefined, undefined, {});
  await handlers.get("agent_end")![0]({ messages: [
    { role: "user", content: "automatic user" },
    { role: "toolResult", content: "raw read/bash/lark-cli output" },
    { role: "assistant", content: [{ type: "text", text: "automatic assistant" }] },
  ] });

  assert.deepEqual(additions.map(([, options]) => ({ userId: options.userId, appId: options.appId })), [
    { userId: "feishu:alice", appId: "repo-collision-proof" },
    { userId: "feishu:alice", appId: "repo-collision-proof" },
    { userId: "feishu:alice", appId: undefined },
    { userId: "feishu:alice", appId: undefined },
    { userId: "feishu:alice", appId: "repo-collision-proof" },
  ]);
  assert.deepEqual(additions.at(-1)![0], [
    { role: "user", content: "automatic user" },
    { role: "assistant", content: "automatic assistant" },
  ]);
  assert.equal(process.env.MEM0_USER_ID, "foreign-user");
});


test("healthy Dream uses package semantics and stores its state under Feishu Agent Home", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-memory-dream-")); const agent = join(root, ".feishu-agent");
  writeMemoryConfig(agent, "alice"); process.env.MEM0_API_KEY = "dream-key";
  const client = { ping: async () => {}, search: async () => ({ results: [] }), getAll: async () => ({ count: 25, results: [] }), add: async () => ({}), update: async () => ({}), delete: async () => ({}), deleteAll: async () => ({}) };
  const runtime = await memoryRuntime(agent, "project-key", () => client);
  const handlers = new Map<string, Function[]>();
  runtime.extension!({ on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]), registerTool: () => {}, registerCommand: () => {} } as never);
  await handlers.get("session_start")![0]({}, { sessionManager: { getSessionFile: () => join(agent, "sessions", "session.jsonl") } });
  for (let index = 1; index < 5; index++) incrementSessionCount(join(agent, "memory-state"), `session-${index}`);
  const result = await handlers.get("before_agent_start")![0]({ prompt: "remember", systemPrompt: "base" });
  assert.match(result.systemPrompt, /<mem0-dream>/);
  assert(readdirSync(join(agent, "memory-state")).some((name) => name.includes("dream")));
  assert.equal(readdirSync(root).some((name) => name === ".pi"), false);
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
