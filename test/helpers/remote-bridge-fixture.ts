import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { projectKeyFor } from "../../src/policy.js";
import { packageManager } from "../../src/packages.js";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const cli = join(repoRoot, "dist/src/cli.js");
export const SECRET = "FEISHU-SECRET-supersecret-42";

export interface PtyAction { wait?: string; waitFile?: string; send?: string; }

export function runPty(cwd: string, args: string[], env: NodeJS.ProcessEnv, actions: PtyAction[], timeoutSec = 60, timeoutProgress?: () => Record<string, number>): Promise<{ code: number | null; output: string }> {
  const python = `import json,os,pty,select,sys,time\nactions=json.loads(sys.argv[4]); timeout=float(sys.argv[6]); pid,fd=pty.fork()\nif pid==0:\n os.chdir(sys.argv[1]); os.execvpe(sys.argv[2],[sys.argv[2],sys.argv[3],*json.loads(sys.argv[5])],os.environ)\nout=b''; checkpoint=0; action=0; resends=0; started=time.time(); end=started+timeout; last_resend=0; last_send=None; last_sent_at=0; stall_resends=0\nwhile time.time()<end:\n r,_,_=select.select([fd],[],[],0.1)\n if r:\n  try: out+=os.read(fd,65536)\n  except OSError:\n   _,status=os.waitpid(pid,0); print(out.decode('utf-8','replace')); sys.exit(os.waitstatus_to_exitcode(status))\n ready=False\n if action<len(actions):\n  a=actions[action]\n  if a.get('waitFile'): ready=os.path.exists(a['waitFile'])\n  elif a.get('wait') and a['wait'].encode() in out[checkpoint:]: ready=True\n if ready:\n  time.sleep(.15); s=actions[action].get('send') or ''\n  if s: os.write(fd,s.encode())\n  last_send=s.encode() if s else None; last_sent_at=time.time(); stall_resends=0\n  checkpoint=len(out); action+=1\n elif action<len(actions) and last_send and stall_resends<1 and time.time()-last_sent_at>5:\n  os.write(fd,last_send); last_sent_at=time.time(); stall_resends=1\n elif action==len(actions) and actions and resends<15 and time.time()-last_resend>2 and actions[-1].get('send'):\n  try: os.write(fd,actions[-1]['send'].encode())\n  except OSError: pass\n  resends+=1; last_resend=time.time()\n p,status=os.waitpid(pid,os.WNOHANG)\n if p:\n  print(out.decode('utf-8','replace')); sys.exit(os.waitstatus_to_exitcode(status) if action==len(actions) else 125)\nelapsed=time.time()-started\n# Ask the fixture to snapshot progress before cleanup can finalize a card.\nos.write(3,b'timeout')\nready,_,_=select.select([0],[],[],1)\nprogress_captured=bool(ready and os.read(0,1)==b'1')\nos.kill(pid,15)\n# Reap the timed-out CLI; SIGKILL bounds cleanup if SIGTERM is ignored.\ncleanup_end=time.time()+1\nwhile True:\n p,status=os.waitpid(pid,os.WNOHANG)\n if p: break\n if time.time()>=cleanup_end:\n  os.kill(pid,9); os.waitpid(pid,0); break\n time.sleep(.01)\na=actions[action] if action<len(actions) else {}\nprint('PTY_TIMEOUT '+json.dumps(dict(action=action,totalActions=len(actions),expected=a.get('waitFile') or a.get('wait') or '<process exit>',elapsedSec=round(elapsed,3),progressCaptured=progress_captured,tail=out.decode('utf-8','replace')))); sys.exit(124)`;
  return new Promise((done) => {
    const child = spawn("python3", ["-c", python, cwd, process.execPath, cli, JSON.stringify(actions), JSON.stringify(args), String(timeoutSec)], { env, stdio: ["pipe", "pipe", "pipe", "pipe"] });
    let progress: Record<string, number> | undefined;
    // Dedicated pipe avoids mixing the handshake with terminal content or credentials.
    child.stdio[3]!.once("data", () => {
      progress = timeoutProgress?.();
      child.stdin!.end("1");
    });
    // The bounded Python handshake may expire first; a closed pipe is best-effort.
    child.stdin!.on("error", () => {});
    let output = "";
    child.stdout!.on("data", (chunk) => output += chunk);
    child.stderr!.on("data", (chunk) => output += chunk);
    child.on("close", (code) => {
      if (code === 124 && output.startsWith("PTY_TIMEOUT ")) {
        // Only sanitize failure diagnostics: success output stays raw for leak assertions.
        const secrets = [SECRET, "fake-key", ...Object.entries(env)
          .filter(([key]) => /secret|token|api_?key|password/i.test(key))
          .map(([, value]) => value).filter((value): value is string => Boolean(value))];
        const sanitize = (text: string) => {
          let clean = stripVTControlCharacters(text);
          for (const secret of secrets) clean = clean.replaceAll(secret, "[REDACTED]");
          return clean.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
        };
        const diagnostic = JSON.parse(output.slice("PTY_TIMEOUT ".length));
        diagnostic.expected = sanitize(diagnostic.expected).slice(0, 256);
        diagnostic.tail = sanitize(diagnostic.tail).slice(-4096);
        diagnostic.progress = diagnostic.progressCaptured ? progress : undefined;
        delete diagnostic.progressCaptured;
        output = `PTY_TIMEOUT ${JSON.stringify(diagnostic)}\n`;
      }
      done({ code, output });
    });
  });
}

export interface InboundEvent {
  ownerOpenId: string;
  chatId: string;
  chatType: string;
  messageId: string;
  messageType: string;
  text: string;
}

export interface FeishuStats {
  polls: number;
  pollTimes: number[];
  sends: Array<{ chatId: string; text: string; at: number }>;
  closes: number[];
  cards: {
    opened: Array<{ chatId: string; cardId: string; at: number }>;
    statuses: Array<{ cardId: string; text: string; at: number }>;
    appends: Array<{ cardId: string; text: string; sequence: number; uuid: string; at: number }>;
    closes: Array<{ cardId: string; text: string; at: number }>;
  };
}

export async function feishuLoopback(script: Array<{ delayMs: number; event: InboundEvent }>, options: { failPollsAfterFirst?: number; cardOpenDelayMs?: number; holdFirstPollUntil?: string } = {}): Promise<{ server: Server; url: string; stats(): Promise<FeishuStats>; timeoutProgress(): Record<string, number> }> {
  const state = {
    pending: [] as InboundEvent[],
    waiters: [] as Array<(events: InboundEvent[]) => void>,
    sends: [] as Array<{ chatId: string; text: string; at: number }>,
    closes: [] as number[],
    opened: [] as Array<{ chatId: string; cardId: string; at: number }>,
    statuses: [] as Array<{ cardId: string; text: string; at: number }>,
    appends: [] as Array<{ cardId: string; text: string; sequence: number; uuid: string; at: number }>,
    cardCloses: [] as Array<{ cardId: string; text: string; at: number }>,
    polls: 0,
    pollTimes: [] as number[],
    scripted: false,
  };
  const server = createServer((request, response) => {
    if (request.url === "/events") {
      state.polls++;
      state.pollTimes.push(Date.now());
      if (state.polls > 1 && (options.failPollsAfterFirst ?? 0) > 0) {
        options.failPollsAfterFirst!--;
        response.destroy();
        return;
      }
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
      const waitOrFlush = () => {
        if (state.pending.length) return flush(state.pending.splice(0));
        const waiter = (events: InboundEvent[]) => flush(events);
        state.waiters.push(waiter);
        setTimeout(() => {
          const index = state.waiters.indexOf(waiter);
          if (index >= 0) state.waiters.splice(index, 1);
          flush([]);
        }, 2000).unref();
      };
      if (options.holdFirstPollUntil && state.polls === 1 && !existsSync(options.holdFirstPollUntil)) {
        const timer = setInterval(() => {
          if (!existsSync(options.holdFirstPollUntil!)) return;
          clearInterval(timer);
          waitOrFlush();
        }, 50);
        timer.unref();
        return;
      }
      waitOrFlush();
      return;
    }
    let body = "";
    request.on("data", (chunk) => body += chunk);
    request.on("end", () => {
      if (request.url === "/send-message") { state.sends.push({ ...(JSON.parse(body) as { chatId: string; text: string }), at: Date.now() }); response.writeHead(200).end(); }
      else if (request.url === "/open-stream-card") {
        const { chatId } = JSON.parse(body) as { chatId: string };
        const cardId = `card-${state.opened.length + 1}`;
        state.opened.push({ chatId, cardId, at: Date.now() });
        const respond = () => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ cardId }));
        };
        if (options.cardOpenDelayMs) setTimeout(respond, options.cardOpenDelayMs).unref();
        else respond();
      }
      else if (request.url === "/set-status-line") {
        const { cardId, text } = JSON.parse(body) as { cardId: string; text: string };
        state.statuses.push({ cardId, text, at: Date.now() });
        response.writeHead(200).end();
      }
      else if (request.url === "/append-stream-text") {
        const { cardId, text, sequence, uuid } = JSON.parse(body) as { cardId: string; text: string; sequence: number; uuid: string };
        state.appends.push({ cardId, text, sequence, uuid, at: Date.now() });
        response.writeHead(200).end();
      }
      else if (request.url === "/close-stream-card") {
        const { cardId, text } = JSON.parse(body) as { cardId: string; text: string };
        state.cardCloses.push({ cardId, text, at: Date.now() });
        response.writeHead(200).end();
      }
      else if (request.url === "/disconnect") { state.closes.push(Date.now()); response.writeHead(200).end(); }
      else if (request.url === "/stats") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ polls: state.polls, pollTimes: state.pollTimes, sends: state.sends, closes: state.closes, cards: { opened: state.opened, statuses: state.statuses, appends: state.appends, closes: state.cardCloses } })); }
      else response.writeHead(404).end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    timeoutProgress: () => ({ cardsOpened: state.opened.length, cardAppends: state.appends.length, cardsClosed: state.cardCloses.length }),
    stats: async () => {
      const response = await fetch(`http://127.0.0.1:${address.port}/stats`);
      return (await response.json()) as FeishuStats;
    },
  };
}

export interface ModelPlan {
  delayMs?: number;
  sse?: string;
  stream?: Array<{ line: string; delayMs: number }>;
}

export type ModelResponder = (lastUserText: string) => ModelPlan;

export function sse(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
}

export function sseDelta(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`;
}

export function sseDone(): string {
  return `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
}

export async function modelServer(responder: ModelResponder): Promise<{ server: Server; modelUrl: string; timeoutProgress(): Record<string, number> }> {
  let requests = 0;
  let responsesFinished = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => body += chunk);
    request.on("end", () => {
      if (!request.url?.endsWith("/chat/completions")) return response.writeHead(404).end();
      requests++;
      response.once("finish", () => responsesFinished++);
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
      const write = () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (plan.stream) {
          let index = 0;
          const step = () => {
            if (index >= plan.stream!.length) return response.end();
            response.write(plan.stream![index].line);
            setTimeout(step, plan.stream![index].delayMs).unref();
            index += 1;
          };
          step();
        } else {
          response.end(plan.sse ?? "");
        }
      };
      if (plan.delayMs) setTimeout(write, plan.delayMs).unref();
      else write();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  return { server, modelUrl: `http://127.0.0.1:${address.port}/v1`, timeoutProgress: () => ({ modelRequests: requests, modelResponsesFinished: responsesFinished }) };
}

export async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}

export interface RemoteFixture {
  root: string;
  home: string;
  project: string;
  bin: string;
  larkTrace: string;
  model: { server: Server; modelUrl: string };
  feishu: { server: Server; url: string; stats(): Promise<FeishuStats> };
  env: (extra: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  sessionFiles(): string[];
  timeoutProgress(): Record<string, number>;
}

export async function fixture(responder: ModelResponder, script: Array<{ delayMs: number; event: InboundEvent }>, loopbackOptions: { failPollsAfterFirst?: number; cardOpenDelayMs?: number; holdFirstPollUntil?: string } = {}): Promise<RemoteFixture> {
  const root = mkdtempSync(join(tmpdir(), "feishu-remote-bridge-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const bin = join(root, "bin");
  const larkTrace = join(root, "lark.log");
  const model = await modelServer(responder);
  const feishu = await feishuLoopback(script, loopbackOptions);
  for (const path of [join(home, ".pi", "agent"), join(home, ".feishu-agent"), join(home, ".lark-cli"), project, bin]) mkdirSync(path, { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "fake-key" } }));
  writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: { fake: { baseUrl: model.modelUrl, api: "openai-completions", models: [{ id: "fake-model", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 256 }] } } }));
  writeFileSync(join(home, ".feishu-agent", "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-model", quietStartup: true, collapseChangelog: true }));
  writeFileSync(join(home, ".feishu-agent", "SYSTEM.md"), "You are Feishu Agent.\n");
  writeFileSync(join(home, ".lark-cli", "config.json"), JSON.stringify({ apps: [{ appId: "cli_fake_bridge", brand: "feishu", users: [{ userOpenId: "ou_fake_owner" }] }] }));
  writeFileSync(join(bin, "lark-cli"), `#!/bin/sh\nprintf 'CALL|%s\\n' "$*" >> "${larkTrace}"\ncase "$*" in\n "--version") echo "lark-cli 1.0.0"; exit 0;;\n "skills list --json") echo "[]"; exit 0;;\nesac\necho "FAKE LARK DELETED"; exit 0\n`, { mode: 0o755 });
  await packageManager(join(home, ".feishu-agent"), project, projectKeyFor(project)).installAndPersist(resolve(repoRoot, "packages/feishu-remote"));
  const baseEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}`, LARK_TRACE: larkTrace, PI_OFFLINE: "1", TERM: "xterm-256color", COLUMNS: "110", LINES: "32" };
  delete baseEnv.FEISHU_REMOTE;
  delete baseEnv.FEISHU_REMOTE_APP_SECRET;
  delete baseEnv.FEISHU_REMOTE_LOOPBACK_URL;
  delete baseEnv.FEISHU_REMOTE_APP_ID;
  delete baseEnv.FEISHU_REMOTE_OWNER_OPEN_ID;
  return {
    root, home, project, bin, larkTrace, model, feishu,
    timeoutProgress: () => ({ ...model.timeoutProgress(), ...feishu.timeoutProgress() }),
    env: (extra: NodeJS.ProcessEnv) => ({ ...baseEnv, ...extra }),
    sessionFiles(): string[] {
      const dir = join(home, ".feishu-agent", "sessions", projectKeyFor(project));
      if (!existsSync(dir)) return [];
      return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => readFileSync(join(dir, name), "utf8"));
    },
  };
}

export const echoModel: ModelResponder = (lastUser) => ({ sse: sse(`PTY-PONG:${lastUser}`) });

export const BRIDGE_APP_ID = "cli_fake_bridge";

export function lockFile(home: string): string {
  return join(home, ".cache", "feishu-remote", `${BRIDGE_APP_ID}.lock`);
}

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid);
  await new Promise((done) => child.once("exit", done));
  for (let attempt = 0; attempt < 20 && pidIsAlive(pid); attempt++) await new Promise((done) => setTimeout(done, 10));
  assert.equal(pidIsAlive(pid), false);
  return pid;
}

export function plantLock(home: string, pid: number): void {
  mkdirSync(join(home, ".cache", "feishu-remote"), { recursive: true });
  writeFileSync(lockFile(home), `${pid}\n`);
}
