import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { projectKeyFor } from "../src/policy.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "dist/src/cli.js");
const SECRET = "FEISHU-SECRET-supersecret-42";

interface PtyAction { wait: string; send?: string; }

function runPty(cwd: string, args: string[], env: NodeJS.ProcessEnv, actions: PtyAction[]): Promise<{ code: number | null; output: string }> {
  const python = `import json,os,pty,select,sys,time\nactions=json.loads(sys.argv[4]); pid,fd=pty.fork()\nif pid==0:\n os.chdir(sys.argv[1]); os.execvpe(sys.argv[2],[sys.argv[2],sys.argv[3],*json.loads(sys.argv[5])],os.environ)\nout=b''; checkpoint=0; action=0; resends=0; end=time.time()+60; last_resend=0; last_send=None; last_sent_at=0; stall_resends=0\nwhile time.time()<end:\n r,_,_=select.select([fd],[],[],0.1)\n if r:\n  try: out+=os.read(fd,65536)\n  except OSError:\n   _,status=os.waitpid(pid,0); print(out.decode('utf-8','replace')); sys.exit(os.waitstatus_to_exitcode(status))\n if action<len(actions) and actions[action]['wait'].encode() in out[checkpoint:]:\n  time.sleep(.15); s=actions[action].get('send') or ''\n  if s: os.write(fd,s.encode())\n  last_send=s.encode() if s else None; last_sent_at=time.time(); stall_resends=0\n  checkpoint=len(out); action+=1\n elif action<len(actions) and last_send and stall_resends<1 and time.time()-last_sent_at>5:\n  os.write(fd,last_send); last_sent_at=time.time(); stall_resends=1\n elif action==len(actions) and actions and resends<2 and time.time()-last_resend>2 and actions[-1].get('send'):\n  try: os.write(fd,actions[-1]['send'].encode())\n  except OSError: pass\n  resends+=1; last_resend=time.time()\n p,status=os.waitpid(pid,os.WNOHANG)\n if p:\n  print(out.decode('utf-8','replace')); sys.exit(os.waitstatus_to_exitcode(status) if action==len(actions) else 125)\nos.kill(pid,15); print(out.decode('utf-8','replace')); sys.exit(124)`;
  return new Promise((done) => {
    const child = spawn("python3", ["-c", python, cwd, process.execPath, cli, JSON.stringify(actions), JSON.stringify(args)], { env });
    let output = "";
    child.stdout.on("data", (chunk) => output += chunk);
    child.stderr.on("data", (chunk) => output += chunk);
    child.on("close", (code) => done({ code, output }));
  });
}

interface InboundEvent {
  ownerOpenId: string;
  chatId: string;
  chatType: string;
  messageId: string;
  messageType: string;
  text: string;
}

interface FeishuStats {
  polls: number;
  pollTimes: number[];
  sends: Array<{ chatId: string; text: string }>;
  closes: number[];
}

async function feishuLoopback(script: Array<{ delayMs: number; event: InboundEvent }>): Promise<{ server: Server; url: string; stats(): Promise<FeishuStats> }> {
  const state = {
    pending: [] as InboundEvent[],
    waiters: [] as Array<(events: InboundEvent[]) => void>,
    sends: [] as Array<{ chatId: string; text: string }>,
    closes: [] as number[],
    polls: 0,
    pollTimes: [] as number[],
    scripted: false,
  };
  const server = createServer((request, response) => {
    if (request.url === "/events") {
      state.polls++;
      state.pollTimes.push(Date.now());
      if (!state.scripted) {
        state.scripted = true;
        for (const step of script) setTimeout(() => {
          state.pending.push(step.event);
          for (const waiter of state.waiters.splice(0)) waiter([]);
        }, step.delayMs).unref();
      }
      const flush = (events: InboundEvent[]) => {
        if (response.writableEnded) return;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(events));
      };
      if (state.pending.length) return flush(state.pending.splice(0));
      const waiter = (events: InboundEvent[]) => flush(events);
      state.waiters.push(waiter);
      setTimeout(() => {
        const index = state.waiters.indexOf(waiter);
        if (index >= 0) state.waiters.splice(index, 1);
        flush([]);
      }, 2000).unref();
      return;
    }
    let body = "";
    request.on("data", (chunk) => body += chunk);
    request.on("end", () => {
      if (request.url === "/send-message") { state.sends.push(JSON.parse(body)); response.writeHead(200).end(); }
      else if (request.url === "/disconnect") { state.closes.push(Date.now()); response.writeHead(200).end(); }
      else if (request.url === "/stats") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ polls: state.polls, pollTimes: state.pollTimes, sends: state.sends, closes: state.closes })); }
      else response.writeHead(404).end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    stats: async () => {
      const response = await fetch(`http://127.0.0.1:${address.port}/stats`);
      return (await response.json()) as FeishuStats;
    },
  };
}

type ModelResponder = (lastUserText: string) => { delayMs?: number; sse: string };

function sse(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
}

async function modelServer(responder: ModelResponder): Promise<{ server: Server; modelUrl: string }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => body += chunk);
    request.on("end", () => {
      if (!request.url?.endsWith("/chat/completions")) return response.writeHead(404).end();
      let lastUser = "";
      try {
        const messages = JSON.parse(body).messages as Array<{ role: string; content: unknown }>;
        const userTexts = messages.filter((message) => message.role === "user").map((message) => {
          if (typeof message.content === "string") return message.content;
          if (Array.isArray(message.content)) return message.content.filter((part): part is { type: string; text?: string } => (part as { type?: string }).type === "text").map((part) => part.text ?? "").join(" ");
          return "";
        });
        lastUser = userTexts[userTexts.length - 1] ?? "";
      } catch { /* not a chat completion */ }
      const plan = responder(lastUser);
      const write = () => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(plan.sse); };
      if (plan.delayMs) setTimeout(write, plan.delayMs).unref();
      else write();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  return { server, modelUrl: `http://127.0.0.1:${address.port}/v1` };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}

async function fixture(responder: ModelResponder, script: Array<{ delayMs: number; event: InboundEvent }>) {
  const root = mkdtempSync(join(tmpdir(), "feishu-remote-bridge-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const bin = join(root, "bin");
  const larkTrace = join(root, "lark.log");
  const model = await modelServer(responder);
  const feishu = await feishuLoopback(script);
  for (const path of [join(home, ".pi", "agent"), join(home, ".feishu-agent"), join(home, ".lark-cli"), project, bin]) mkdirSync(path, { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "fake-key" } }));
  writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: { fake: { baseUrl: model.modelUrl, api: "openai-completions", models: [{ id: "fake-model", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 256 }] } } }));
  writeFileSync(join(home, ".feishu-agent", "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-model", quietStartup: true, collapseChangelog: true }));
  writeFileSync(join(home, ".feishu-agent", "SYSTEM.md"), "You are Feishu Agent.\n");
  writeFileSync(join(home, ".lark-cli", "config.json"), JSON.stringify({ apps: [{ appId: "cli_fake_bridge", brand: "feishu", users: [{ userOpenId: "ou_fake_owner" }] }] }));
  writeFileSync(join(bin, "lark-cli"), `#!/bin/sh\nprintf 'CALL|%s\\n' "$*" >> "${larkTrace}"\ncase "$*" in\n "--version") echo "lark-cli 1.0.0"; exit 0;;\n "skills list --json") echo "[]"; exit 0;;\nesac\necho "FAKE LARK DELETED"; exit 0\n`, { mode: 0o755 });
  const baseEnv = { ...process.env, HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}`, LARK_TRACE: larkTrace, PI_OFFLINE: "1", TERM: "xterm-256color", COLUMNS: "110", LINES: "32" };
  return {
    root, home, project, bin, larkTrace, model, feishu,
    env: (extra: NodeJS.ProcessEnv) => ({ ...baseEnv, ...extra }),
    sessionFiles(): string[] {
      const dir = join(home, ".feishu-agent", "sessions", projectKeyFor(project));
      if (!existsSync(dir)) return [];
      return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => readFileSync(join(dir, name), "utf8"));
    },
  };
}

const echoModel: ModelResponder = (lastUser) => ({ sse: sse(`PTY-PONG:${lastUser}`) });

test("default startup opens no gateway connection; /remote status shows off", async () => {
  const f = await fixture(echoModel, []);
  try {
    const result = await runPty(f.project, [], f.env({}), [
      { wait: "fake-model", send: "/remote status\r" },
      { wait: "Remote bridge: off", send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    assert.doesNotMatch(result.output, /FEISHU_REMOTE_LOOPBACK_URL/);
    const stats = await f.feishu.stats();
    assert.equal(stats.polls, 0, "no loopback polling without activation");
    assert.equal(stats.sends.length, 0);
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("owner P2P message drives the session and gets one plain-text reply; strangers, groups and duplicates are ignored; stop/reload tear down", async () => {
  const f = await fixture(echoModel, [
    { delayMs: 400, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "msg-1", messageType: "text", text: "phone-message-1" } },
    { delayMs: 900, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "msg-1", messageType: "text", text: "phone-message-1" } },
    { delayMs: 1100, event: { ownerOpenId: "ou_intruder", chatId: "oc_phone", chatType: "p2p", messageId: "msg-2", messageType: "text", text: "intruder-message" } },
    { delayMs: 1300, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_group", chatType: "group", messageId: "msg-3", messageType: "text", text: "group-noise" } },
  ]);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "/remote start\r" },
      { wait: "Remote bridge connected", send: "" },
      { wait: "phone-message-1", send: "" },
      { wait: "PTY-PONG:phone-message-1", send: "/remote status\r" },
      { wait: "Remote bridge: connected", send: "/remote stop\r" },
      { wait: "Remote bridge stopped", send: "/remote status\r" },
      { wait: "Remote bridge: off", send: "/reload\r" },
      { wait: "Reloaded keybindings", send: "/remote status\r" },
      { wait: "Remote bridge: off", send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /remote:connected/);
    assert.doesNotMatch(result.output, /intruder-message|group-noise/);
    assert.doesNotMatch(result.output, /Agent is already processing/);
    const stats = await f.feishu.stats();
    assert.equal(stats.sends.length, 1, `exactly one reply: ${JSON.stringify(stats.sends)}`);
    assert.deepEqual(stats.sends, [{ chatId: "oc_phone", text: "PTY-PONG:phone-message-1" }]);
    assert(stats.closes.length >= 1, "gateway disconnect is recorded on stop");
    assert(stats.pollTimes.every((time) => time <= stats.closes[0]), "no polling after teardown");

    assert.doesNotMatch(result.output, new RegExp(SECRET));
    for (const session of f.sessionFiles()) assert.doesNotMatch(session, new RegExp(SECRET), "app secret must not reach session files");
    assert.doesNotMatch(JSON.stringify(stats), new RegExp(SECRET), "app secret must not reach the loopback");
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("missing app secret on /remote start gives an actionable message and never connects", async () => {
  const f = await fixture(echoModel, []);
  try {
    const result = await runPty(f.project, [], f.env({}), [
      { wait: "fake-model", send: "/remote start\r" },
      { wait: "FEISHU_REMOTE_APP_SECRET", send: "/remote status\r" },
      { wait: "Remote bridge: error", send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /FEISHU_REMOTE_APP_SECRET/);
    assert.match(result.output, /remote:error/);
    const stats = await f.feishu.stats();
    assert.equal(stats.polls, 0, "missing secret must not connect");
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("FEISHU_REMOTE=1 autostarts and a message arriving during a busy turn is queued and answered without errors", async () => {
  const slowModel: ModelResponder = (lastUser) => ({
    delayMs: lastUser.includes("SLOW") ? 1500 : 0,
    sse: sse(`PTY-PONG:${lastUser}`),
  });
  const f = await fixture(slowModel, [
    { delayMs: 400, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "slow-1", messageType: "text", text: "SLOW-phone-1" } },
    { delayMs: 900, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "fast-2", messageType: "text", text: "followup-2" } },
  ]);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      { wait: "SLOW-phone-1", send: "" },
      { wait: "PTY-PONG:SLOW-phone-1", send: "" },
      { wait: "PTY-PONG:followup-2", send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    assert.doesNotMatch(result.output, /Agent is already processing/);
    assert.doesNotMatch(result.output, new RegExp(SECRET));
    const stats = await f.feishu.stats();
    assert.equal(stats.sends.length, 2, JSON.stringify(stats.sends));
    assert.match(stats.sends[0].text, /SLOW-phone-1/);
    assert.match(stats.sends[1].text, /followup-2/);
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});

test("High-risk Approval guard still applies to phone-originated turns", async () => {
  const exactCommand = "lark-cli doc delete doc-1 --as user --yes";
  const responses = [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "guard-1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: exactCommand }) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
    sse("GUARD-DONE"),
  ];
  const guardedModel: ModelResponder = () => ({ sse: responses.shift() ?? sse("NO-RESPONSES-LEFT") });
  const f = await fixture(guardedModel, [
    { delayMs: 400, event: { ownerOpenId: "ou_fake_owner", chatId: "oc_phone", chatType: "p2p", messageId: "guard-1", messageType: "text", text: "整理一下文档" } },
  ]);
  try {
    const result = await runPty(f.project, [], f.env({ FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: SECRET, FEISHU_REMOTE_LOOPBACK_URL: f.feishu.url }), [
      { wait: "fake-model", send: "" },
      { wait: "remote:connected", send: "" },
      { wait: "整理一下文档", send: "" },
      { wait: "Blocked lark-cli --yes", send: "" },
      { wait: "GUARD-DONE", send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    const calls = existsSync(f.larkTrace) ? readFileSync(f.larkTrace, "utf8").trim().split("\n").filter((line) => !line.endsWith("--version") && !line.endsWith("skills list --json")) : [];
    assert.deepEqual(calls, [], "blocked command must never reach lark-cli");
    const stats = await f.feishu.stats();
    assert.equal(stats.sends.length, 1, JSON.stringify(stats.sends));
    assert.equal(stats.sends[0].text, "GUARD-DONE");
  } finally {
    await closeServer(f.feishu.server);
    await closeServer(f.model.server);
  }
});
