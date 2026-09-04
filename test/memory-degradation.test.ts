import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { corePolicyExtension } from "../src/core-extension.js";
import { memoryWarning, redactSecrets } from "../src/memory-degradation.js";
import { memoryRuntime, writeMemoryConfig } from "../src/memory.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "dist/src/cli.js");
const apiKeySentinel = "MEM0-API-KEY-SENTINEL-16";
const toolOutputSentinel = "RAW-TOOL-OUTPUT-SENTINEL-16";

const textResponse = (text: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
function toolResponse(name: string, input: unknown, id: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
}

function files(root: string): string[] {
  const output: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (lstatSync(path).isSymbolicLink()) continue;
    if (statSync(path).isDirectory()) output.push(...files(path));
    else output.push(path);
  }
  return output;
}

function run(cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function runPty(cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  const python = `import os,pty,select,sys,time\npid,fd=pty.fork()\nif pid==0:\n os.chdir(sys.argv[1]); os.execvpe(sys.argv[2],[sys.argv[2],sys.argv[3]],os.environ)\nout=b''; sent=False; end=time.time()+60\nwhile time.time()<end:\n r,_,_=select.select([fd],[],[],0.1)\n if r:\n  try: out+=os.read(fd,65536)\n  except OSError:\n   _,status=os.waitpid(pid,0); print(out.decode('utf-8','replace')); sys.exit(os.waitstatus_to_exitcode(status))\n if not sent and b'Warning: Startup Warning: Long-term Memory' in out and b'unavailable' in out:\n  time.sleep(.2); os.write(fd,b'/quit\\r'); sent=True\n p,status=os.waitpid(pid,os.WNOHANG)\n if p:\n  print(out.decode('utf-8','replace')); sys.exit(os.waitstatus_to_exitcode(status) if sent else 125)\nos.kill(pid,15); print(out.decode('utf-8','replace')); sys.exit(124)`;
  return new Promise((done) => {
    const child = spawn("python3", ["-c", python, cwd, process.execPath, cli], { env });
    let output = "";
    child.stdout.on("data", (chunk) => output += chunk);
    child.stderr.on("data", (chunk) => output += chunk);
    child.on("close", (code) => done({ code, output }));
  });
}

function client(overrides: Record<string, Function> = {}) {
  return {
    ping: async () => {},
    add: async () => [],
    search: async () => ({ results: [] }),
    getAll: async () => ({ results: [] }),
    update: async () => ({}),
    delete: async () => ({}),
    deleteAll: async () => ({}),
    ...overrides,
  };
}

function mount(extension: NonNullable<Awaited<ReturnType<typeof memoryRuntime>>["extension"]>, sendMessage: (message: unknown) => void = () => {}) {
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  let tool: any;
  extension({
    on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (registered: any) => { tool = registered; },
    sendMessage,
  } as never);
  const notifications: string[] = [];
  const statusCalls: Array<[string, string | undefined]> = [];
  const ctx = {
    mode: "tui",
    ui: {
      notify: (message: string) => notifications.push(message),
      confirm: async () => false,
      select: async () => undefined,
      setStatus: (key: string, value: string | undefined) => statusCalls.push([key, value]),
    },
    sessionManager: { getSessionFile: () => undefined },
  };
  handlers.get("session_start")?.[0]({}, ctx);
  return { handlers, commands, tool, notifications, statusCalls, ctx };
}

test("delayed first Mem0 ping cannot outlive a successful startup health check", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-memory-constructor-"));
  const agent = join(root, ".feishu-agent");
  writeMemoryConfig(agent, "alice");
  const originalKey = process.env.MEM0_API_KEY;
  const originalHost = process.env.MEM0_API_HOST;
  const originalConsoleError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  process.env.MEM0_API_KEY = apiKeySentinel;
  let requests = 0;
  let releaseFirst!: () => void;
  const firstRequest = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const server = createServer((_request, response) => {
    requests++;
    if (requests > 1) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}');
      return;
    }
    response.on("close", releaseFirst);
    setTimeout(() => {
      if (requests > 1) {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(`late constructor failure ${apiKeySentinel}`);
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"status":"ok"}');
      }
    }, 100);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  process.env.MEM0_API_HOST = `http://127.0.0.1:${address.port}`;
  try {
    const runtime = await memoryRuntime(agent, "project");
    await Promise.race([firstRequest, new Promise((_, reject) => setTimeout(() => reject(new Error("health request did not settle")), 500))]);
    assert(runtime.extension);
    assert.equal(runtime.warning, undefined);
    assert.equal(requests, 1, "Mem0 constructor issued a background ping in addition to the awaited health check");
    assert.doesNotMatch(errors.join("\n"), new RegExp(apiKeySentinel));
  } finally {
    console.error = originalConsoleError;
    server.close();
    if (originalKey === undefined) delete process.env.MEM0_API_KEY;
    else process.env.MEM0_API_KEY = originalKey;
    if (originalHost === undefined) delete process.env.MEM0_API_HOST;
    else process.env.MEM0_API_HOST = originalHost;
  }
});

test("actual Dream tool failure degrades the session and does not record completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-memory-dream-tool-"));
  const agent = join(root, ".feishu-agent");
  writeMemoryConfig(agent, "alice");
  process.env.MEM0_API_KEY = apiKeySentinel;
  const calls: string[] = [];
  const runtime = await memoryRuntime(agent, "project", () => client({
    add: async () => { calls.push("add"); throw new Error(`dream tool failed ${apiKeySentinel}`); },
    delete: async () => { calls.push("delete"); throw new Error(`dream tool failed ${apiKeySentinel}`); },
    search: async () => { calls.push("search"); return { results: [] }; },
  }));
  const mounted = mount(runtime.extension!);
  await mounted.commands.get("mem0-dream").handler("", mounted.ctx);
  const result = await mounted.tool.execute("dream-delete", { action: "delete", memory_id: "stale" }, undefined, undefined, {});
  assert.match(result.content[0].text, /Memory dream unavailable/);
  assert.match(runtime.diagnostic()!, /Memory dream unavailable/);
  assert.doesNotMatch(runtime.diagnostic()!, new RegExp(apiKeySentinel));
  assert.equal(existsSync(join(agent, "memory-state", "mem0-dream.lock")), false);
  await mounted.handlers.get("agent_end")![0]({ messages: [{ role: "assistant", content: [{ type: "tool_use", name: "mem0_memory", input: { action: "add" } }] }] }, mounted.ctx);
  assert.equal(existsSync(join(agent, "memory-state", "mem0-dream-state.json")), true);
  const state = JSON.parse(readFileSync(join(agent, "memory-state", "mem0-dream-state.json"), "utf8"));
  assert.equal(state.lastConsolidatedAt, 0);
  const before = calls.length;
  await mounted.handlers.get("before_agent_start")![0]({ prompt: "skip", systemPrompt: "base" }, mounted.ctx);
  await mounted.tool.execute("skip", { action: "search", query: "skip" }, undefined, undefined, {});
  assert.equal(calls.length, before);
});

test("memory degradation warnings redact API keys for every failure class", () => {
  process.env.MEM0_API_KEY = apiKeySentinel;
  assert.equal(redactSecrets(`failed ${apiKeySentinel}`), "failed [REDACTED]");
  for (const feature of ["load", "health", "recall", "capture", "dream"] as const) {
    const warning = memoryWarning(feature, new Error(`failed ${apiKeySentinel}`));
    assert.match(warning, new RegExp(`Long-term Memory ${feature} unavailable for this session`));
    assert.doesNotMatch(warning, new RegExp(apiKeySentinel));
  }
});

test("missing key, composition load, and health failures remain non-blocking and mount visible TUI diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-memory-startup-degraded-"));
  const agent = join(root, ".feishu-agent");
  writeMemoryConfig(agent, "alice");
  const originalKey = process.env.MEM0_API_KEY;
  try {
    delete process.env.MEM0_API_KEY;
    const missing = await memoryRuntime(agent, "project");
    assert.equal(missing.extension, undefined);
    assert.match(missing.warning!, /Memory load unavailable.*MEM0_API_KEY is missing/);
    const startHandlers = new Map<string, Function>();
    corePolicyExtension(undefined, undefined, missing.diagnostic)({ on: (name: string, handler: Function) => startHandlers.set(name, handler), registerCommand: () => {} } as never);
    const notifications: string[] = [];
    startHandlers.get("session_start")!({}, { mode: "tui", ui: { notify: (message: string) => notifications.push(message), getEditorComponent: () => undefined, setEditorComponent: () => {} } });
    assert.deepEqual(notifications, [missing.warning]);

    process.env.MEM0_API_KEY = apiKeySentinel;
    const load = await memoryRuntime(agent, "project", () => client());
    assert(load.extension);
    const loadHandlers = new Map<string, Function[]>();
    const originalWrite = process.stderr.write;
    const loadStderr: string[] = [];
    process.stderr.write = ((chunk: any) => { loadStderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      load.extension({
        on: (name: string, handler: Function) => loadHandlers.set(name, [...(loadHandlers.get(name) ?? []), handler]),
        registerTool: () => { throw new Error(`composition failed ${apiKeySentinel}`); },
        registerCommand: () => {},
      } as never);
    } finally { process.stderr.write = originalWrite; }
    const loadNotifications: string[] = [];
    loadHandlers.get("session_start")?.[0]({}, { mode: "tui", ui: { notify: (message: string) => loadNotifications.push(message) }, sessionManager: { getSessionFile: () => undefined } });
    assert.match(load.diagnostic()!, /Memory load unavailable/);
    assert(loadNotifications.some((message) => message.includes("Memory load unavailable")));
    assert.doesNotMatch(load.diagnostic()!, new RegExp(apiKeySentinel));

    const health = await memoryRuntime(agent, "project", () => client({ ping: async () => { throw new Error(`health failed ${apiKeySentinel}`); } }));
    assert.equal(health.extension, undefined);
    assert.match(health.warning!, /Memory health unavailable/);
    assert.doesNotMatch(health.warning!, new RegExp(apiKeySentinel));
  } finally {
    if (originalKey === undefined) delete process.env.MEM0_API_KEY;
    else process.env.MEM0_API_KEY = originalKey;
  }
});

test("recall, capture, and direct Dream failures warn in TUI and stderr, then skip all memory activity", async (t) => {
  const originalWrite = process.stderr.write;
  const stderr: string[] = [];
  process.stderr.write = ((chunk: any) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
  process.env.MEM0_API_KEY = apiKeySentinel;
  try {
    for (const feature of ["recall", "capture", "dream"] as const) await t.test(feature, async () => {
      const root = mkdtempSync(join(tmpdir(), `feishu-memory-${feature}-`));
      const agent = join(root, ".feishu-agent");
      writeMemoryConfig(agent, "alice");
      const calls: string[] = [];
      const failing = client({
        search: async () => { calls.push("search"); if (feature === "recall") throw new Error(`recall ${apiKeySentinel}`); return { results: [] }; },
        add: async () => { calls.push("add"); if (feature === "capture") throw new Error(`capture ${apiKeySentinel}`); return []; },
      });
      let dreamMessages = 0;
      const sendMessage = feature === "dream" ? (() => { if (dreamMessages++ === 0) throw new Error(`dream ${apiKeySentinel}`); }) : (() => {});
      const runtime = await memoryRuntime(agent, "project", () => failing);
      const mounted = mount(runtime.extension!, sendMessage);
      if (feature === "recall") await mounted.handlers.get("before_agent_start")![0]({ prompt: "remember", systemPrompt: "base" }, mounted.ctx);
      if (feature === "capture") await mounted.handlers.get("agent_end")![0]({ messages: [{ role: "user", content: "capture me" }] }, mounted.ctx);
      if (feature === "dream") await mounted.commands.get("mem0-dream").handler("", mounted.ctx);

      assert.match(runtime.diagnostic!()!, new RegExp(`Memory ${feature} unavailable`));
      assert(mounted.notifications.some((message) => message.includes(`Memory ${feature} unavailable`)), mounted.notifications.join("\n"));
      assert.doesNotMatch(mounted.notifications.join("\n"), new RegExp(apiKeySentinel));
      assert.match(stderr.join(""), new RegExp(`Memory ${feature} unavailable`));
      assert.doesNotMatch(stderr.join(""), new RegExp(apiKeySentinel));

      const before = calls.length;
      await mounted.handlers.get("before_agent_start")![0]({ prompt: "skip recall and dream", systemPrompt: "base" }, mounted.ctx);
      await mounted.handlers.get("agent_end")![0]({ messages: [{ role: "user", content: "skip capture" }, { role: "toolResult", content: toolOutputSentinel }] }, mounted.ctx);
      await mounted.tool.execute("skip-tool", { action: "search", query: "skip" }, undefined, undefined, {});
      await mounted.commands.get("mem0-search").handler("skip", mounted.ctx);
      await mounted.commands.get("mem0-dream").handler("", mounted.ctx);
      assert.equal(calls.length, before, `${feature} degradation repeated a memory call`);
    });
  } finally { process.stderr.write = originalWrite; }
});

test("a later healthy invocation restores recall and capture without changing Feishu settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-memory-recovery-"));
  const agent = join(root, ".feishu-agent");
  mkdirSync(agent, { recursive: true });
  writeMemoryConfig(agent, "alice");
  const settings = '{"defaultProvider":"fake","unrelated":"preserved"}\n';
  writeFileSync(join(agent, "settings.json"), settings);
  process.env.MEM0_API_KEY = apiKeySentinel;
  const degraded = await memoryRuntime(agent, "project", () => client({ ping: async () => { throw new Error("offline"); } }));
  assert.equal(degraded.extension, undefined);

  const calls: string[] = [];
  const healthy = await memoryRuntime(agent, "project", () => client({ search: async () => { calls.push("search"); return { results: [] }; }, add: async () => { calls.push("add"); return []; } }));
  const mounted = mount(healthy.extension!);
  await mounted.handlers.get("before_agent_start")![0]({ prompt: "healthy", systemPrompt: "base" }, mounted.ctx);
  await mounted.handlers.get("agent_end")![0]({ messages: [{ role: "user", content: "healthy capture" }] }, mounted.ctx);
  assert.deepEqual(calls, ["search", "add"]);
  assert.equal(readFileSync(join(agent, "settings.json"), "utf8"), settings);
});

test("degraded Print still runs core write/Bash and fake lark-cli, mounted TUI warns, and recursive artifacts are secret-safe", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-memory-e2e-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const bin = join(root, "bin");
  const logs = join(root, "logs");
  const larkTrace = join(logs, "lark.log");
  const outputFile = join(project, "core-write.txt");
  for (const path of [join(home, ".pi", "agent"), join(home, ".feishu-agent"), project, bin, logs]) mkdirSync(path, { recursive: true });
  writeMemoryConfig(join(home, ".feishu-agent"), "alice");
  writeFileSync(join(home, ".pi", "agent", "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "fake-model-key" } }));
  const responses = [
    toolResponse("write", { path: outputFile, content: "CORE-FILE-OK" }, "write-1"),
    toolResponse("bash", { command: "printf CORE-BASH-OK && lark-cli ping --as user" }, "bash-1"),
    textResponse("DEGRADED-CORE-DONE"),
  ];
  const fakePayloads: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => body += chunk);
    request.on("end", () => {
      fakePayloads.push(body);
      const payload = responses.shift();
      if (!payload) return response.writeHead(500).end("unexpected request");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(payload);
    });
  });
  const mem0Payloads: string[] = [];
  const mem0Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => body += chunk);
    request.on("end", () => {
      mem0Payloads.push(`${request.method} ${request.url}\n${body}`);
      response.writeHead(503, { "content-type": "text/plain" });
      response.end(`memory offline ${apiKeySentinel}`);
    });
  });
  await Promise.all([
    new Promise<void>((done) => server.listen(0, "127.0.0.1", done)),
    new Promise<void>((done) => mem0Server.listen(0, "127.0.0.1", done)),
  ]);
  const address = server.address();
  const mem0Address = mem0Server.address();
  assert(address && typeof address !== "string" && mem0Address && typeof mem0Address !== "string");
  writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", models: [{ id: "fake-model", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 256 }] } } }));
  writeFileSync(join(home, ".feishu-agent", "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-model", quietStartup: true, collapseChangelog: true }));
  writeFileSync(join(home, ".feishu-agent", "SYSTEM.md"), "You are Feishu Agent.\n");
  writeFileSync(join(bin, "lark-cli"), `#!/bin/sh\ncase "$*" in\n "--version") echo "lark-cli 1.0.0";;\n "skills list --json") echo "[]";;\n *) printf 'LARK|%s\\n' "$*" >> "$LARK_TRACE"; printf '${toolOutputSentinel}';;\nesac\n`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}`, PI_OFFLINE: "1", LARK_TRACE: larkTrace, MEM0_API_KEY: apiKeySentinel, MEM0_API_HOST: `http://127.0.0.1:${mem0Address.port}`, TERM: "xterm-256color", COLUMNS: "100", LINES: "30" };
  try {
    const print = await run(project, env, ["-p", "use the core write and Bash tools, then run fake lark-cli"]);
    assert.equal(print.code, 0, print.stderr);
    assert.match(print.stderr, /Long-term Memory health unavailable for this session/);
    assert.match(print.stdout, /DEGRADED-CORE-DONE/);
    assert.equal(readFileSync(outputFile, "utf8"), "CORE-FILE-OK");
    assert.match(readFileSync(larkTrace, "utf8"), /ping --as user/);
    const sessionText = files(join(home, ".feishu-agent")).filter((path) => path.endsWith(".jsonl")).map((path) => readFileSync(path, "utf8")).join("\n");
    assert.match(sessionText, /CORE-BASH-OK/);
    assert.match(sessionText, new RegExp(toolOutputSentinel));

    const tui = await runPty(project, env);
    assert.equal(tui.code, 0, tui.output);
    assert.match(tui.output, /Long-term Memory health unavailable for this session/);

    const diagnostics = [print.stdout, print.stderr, tui.output, ...fakePayloads, ...mem0Payloads].join("\n");
    assert.doesNotMatch(diagnostics, new RegExp(apiKeySentinel));
    for (const scanRoot of [join(home, ".feishu-agent"), project, logs]) {
      for (const path of files(scanRoot)) assert.doesNotMatch(readFileSync(path).toString(), new RegExp(apiKeySentinel), path);
    }
    const sessionFiles = files(join(home, ".feishu-agent")).filter((path) => path.endsWith(".jsonl"));
    assert(sessionFiles.length >= 1);
    for (const path of sessionFiles) assert.doesNotMatch(readFileSync(path, "utf8"), new RegExp(apiKeySentinel), path);
    assert(mem0Payloads.every((payload) => !payload.includes(apiKeySentinel) && !payload.includes(toolOutputSentinel)), "a sentinel reached fake Mem0");
  } finally { await Promise.all([closeServer(server), closeServer(mem0Server)]); }
});

test("memory status updates dynamically during session upon degradation", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-memory-dynamic-status-"));
  const agent = join(root, ".feishu-agent");
  writeMemoryConfig(agent, "alice");
  process.env.MEM0_API_KEY = "status-key";
  const failingClient = client({
    search: async () => { throw new Error("recall error"); },
  });
  const runtime = await memoryRuntime(agent, "project", () => failingClient);
  const mounted = mount(runtime.extension!);
  assert.equal(mounted.statusCalls.find(([k]) => k === "feishu-1-memory")?.[1], "● mem");

  // Degrade via recall error:
  await mounted.handlers.get("before_agent_start")![0]({ prompt: "search", systemPrompt: "base" }, mounted.ctx);
  assert.equal(mounted.statusCalls.filter(([k]) => k === "feishu-1-memory").at(-1)?.[1], "○ mem off");
});

test("timed out health check aborts the in-flight ping and leaves no lingering request", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-memory-abort-"));
  const agent = join(root, ".feishu-agent");
  writeMemoryConfig(agent, "alice");
  process.env.MEM0_API_KEY = "sentinel-key";
  let aborted = false;
  let signalReceived = false;
  const slowClient = {
    ping: (signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
      if (signal) {
        signalReceived = true;
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      }
    }),
    add: async () => [], search: async () => ({ results: [] }), getAll: async () => ({ results: [] }),
    update: async () => ({}), delete: async () => ({}), deleteAll: async () => ({}),
  };
  const runtime = await memoryRuntime(agent, "project", () => slowClient, 50);
  assert.equal(runtime.extension, undefined);
  assert.match(runtime.warning!, /health check timed out after 50ms/);
  assert.equal(signalReceived, true);
  assert.equal(aborted, true);
});
