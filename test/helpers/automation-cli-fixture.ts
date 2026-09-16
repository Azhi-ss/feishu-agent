import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hermeticEnv } from "./hermetic-env.js";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const cli = join(repoRoot, "dist/src/cli.js");

export const MODEL_KEY_SENTINEL = "MEM0-AUTOMATION-KEY-39";
export const REMOTE_SECRET_SENTINEL = "REMOTE-SECRET-SENTINEL-39";
export const TOOL_OUTPUT_SENTINEL = "AUTOMATION-TOOL-OUTPUT-39";

export const textResponse = (text: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;

export const toolResponse = (name: string, input: unknown, id: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;

export function files(root: string): string[] {
  const output: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (lstatSync(path).isSymbolicLink()) continue;
    if (statSync(path).isDirectory()) output.push(...files(path));
    else output.push(path);
  }
  return output;
}

export function profileListJson(profiles: Array<[string, boolean]>): string {
  return JSON.stringify(profiles.map(([name, active]) => ({ name, appId: name, brand: "feishu", active, effective: active, effectiveSource: active ? "config" : "flag" })));
}

export function makeLarkBin(bin: string, cases: string): void {
  writeFileSync(join(bin, "lark-cli"), `#!/bin/sh\ncase "$1 $2" in\n${cases}\n  *)\n    case "$1" in profile) printf '%s' "$LARK_FAKE_PROFILES";; *) echo "unexpected: $*" >&2; exit 2;; esac ;;\nesac\n`, { mode: 0o755 });
}

export const DEFAULT_CASES = (profiles: Array<[string, boolean]>): string => `  "profile list") printf '%s' '${profileListJson(profiles)}' ;;`;

export interface ModelServer {
  server: Server;
  port: number;
  responses: string[];
  requests: string[];
  delayMs: number;
}

export function startModelServer(): Promise<ModelServer> {
  const state: ModelServer = { server: undefined as unknown as Server, port: 0, responses: [], requests: [], delayMs: 0 };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => body += chunk);
    request.on("end", () => {
      state.requests.push(body);
      const payload = state.responses.shift() ?? textResponse("UNEXPECTED-EXTRA-MODEL-REQUEST");
      const timer = setTimeout(() => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(payload);
      }, state.delayMs);
      timer.unref();
      response.on("close", () => clearTimeout(timer));
    });
  });
  state.server = server;
  return new Promise((done) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    assert(address && typeof address !== "string");
    state.port = address.port;
    done(state);
  }));
}

export interface Fixture {
  root: string;
  home: string;
  bin: string;
  jobs: string;
  briefing: string;
  model: ModelServer;
}

export async function fixture(profiles: Array<[string, boolean]> = [["local-default", true]], cases?: string): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "feishu-automation-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const pi = join(home, ".pi", "agent");
  const feishu = join(home, ".feishu-agent");
  const jobs = join(root, "jobs");
  const briefing = join(home, "feishu-automation");
  mkdirSync(pi, { recursive: true });
  mkdirSync(feishu, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(pi, "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "not-secret" } }));
  writeFileSync(join(feishu, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-model", quietStartup: true, collapseChangelog: true }));
  writeFileSync(join(feishu, "SYSTEM.md"), "You are Feishu Agent.\n");
  mkdirSync(join(briefing, "systemd"), { recursive: true });
  writeFileSync(join(briefing, "AGENTS.md"), "BRIEFING-POLICY-SENTINEL do not overwrite\n");
  writeFileSync(join(briefing, "systemd", "feishu-briefing.service"), "briefing unit\n");
  const dir = join(home, ".config", "lark-cli");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), "{}");
  makeLarkBin(bin, cases ?? DEFAULT_CASES(profiles));

  const model = await startModelServer();
  writeFileSync(join(pi, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.port}/v1`, api: "openai-completions", models: [{ id: "fake-model", name: "Fake", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 512 }] } } }));
  return { root, home, bin, jobs, briefing, model };
}

export function createCliHarness() {
  const modelServers: Server[] = [];
  test.after(async () => {
    for (const server of modelServers) {
      server.closeAllConnections?.();
    }
    await Promise.all(modelServers.map((server) => new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))));
  });

  function startGate(initial?: string): Promise<Gate> {
    let open = () => {};
    const gatePromise = new Promise<void>((resolveGate) => { open = resolveGate; });
    const state: Gate = { server: undefined as unknown as Server, port: 0, release: open, responses: initial ? [initial] : [], requests: [] };
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => body += chunk);
      request.on("end", () => {
        state.requests.push(body);
        const payload = state.responses.shift() ?? textResponse("UNEXPECTED-EXTRA-MODEL-REQUEST");
        void gatePromise.then(() => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(payload);
        });
      });
    });
    state.server = server;
    return new Promise((done) => server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address !== "string");
      state.port = address.port;
      modelServers.push(server);
      done(state);
    }));
  }

  return { modelServers, startGate };
}

export function userPromptCount(f: Fixture): number {
  return f.model.requests.reduce((count, raw) => {
    const payload = JSON.parse(raw);
    return count + (payload.messages.at(-1)?.role === "user" ? 1 : 0);
  }, 0);
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function baseEnv(f: Fixture, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return hermeticEnv({
    HOME: f.home,
    PATH: `${f.bin}${delimiter}${process.env.PATH}`,
    PI_OFFLINE: "1",
    FEISHU_AUTOMATION_HOME: f.jobs,
    ...extra,
  });
}

export function runCli(f: Fixture, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): CliResult {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: f.root,
    input: options.input,
    env: baseEnv(f, options.env),
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function addJob(f: Fixture, extraArgs: string[] = [], task = "Self-contained task instructions."): CliResult {
  return runCli(f, ["automation", "add", "--name", "daily-reminder", "--at", "2030-06-01T09:00", "--prompt-stdin", ...extraArgs, "--yes"], { input: `${task}\n` });
}

export function runAutomationAsync(f: Fixture, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [cli, "automation", ...args], {
      cwd: f.root,
      env: baseEnv(f, {
        MEM0_API_KEY: MODEL_KEY_SENTINEL, MEM0_API_HOST: `http://127.0.0.1:${f.model.port}`,
        FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: REMOTE_SECRET_SENTINEL, ...extra,
      }),
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

export function ptyRun(f: Fixture, args: string[], input: string, ready: RegExp, reply: string): Promise<{ code: number | null; output: string }> {
  const python = [
    "import os,pty,re,select,sys,time",
    "cwd=sys.argv[1]; exe=sys.argv[2]; argv=eval(sys.argv[3]); stdin=sys.argv[4]; pattern=sys.argv[5]; reply=sys.argv[6]",
    "pid,fd=pty.fork()",
    "if pid==0:",
    " os.chdir(cwd); os.execvpe(exe,[exe]+argv,os.environ)",
    "sent=False; replied=False; out=b''; end=time.time()+30",
    "os.write(fd, stdin.encode())",
    "while time.time()<end:",
    " r,_,_=select.select([fd],[],[],0.1)",
    " if r:",
    "  try: out+=os.read(fd,65536)",
    "  except OSError:",
    "   _,st=os.waitpid(pid,0); sys.stdout.buffer.write(out); sys.exit(os.waitstatus_to_exitcode(st))",
    " if not replied and re.search(pattern,out.decode('utf-8','replace'),re.I):",
    "  time.sleep(0.2); os.write(fd,reply.encode()+b'\\n'); replied=True",
    " p,st=os.waitpid(pid,os.WNOHANG)",
    " if p and replied:",
    "  sys.stdout.buffer.write(out); sys.exit(os.waitstatus_to_exitcode(st))",
    " if p and not replied:",
    "  sys.stdout.buffer.write(out); sys.exit(os.waitstatus_to_exitcode(st))",
    "os.kill(pid,15); sys.stdout.buffer.write(out); sys.exit(124)",
  ].join("\n");
  return new Promise((done) => {
    const child = spawn("python3", ["-c", python, f.root, process.execPath, JSON.stringify([cli, ...args]), input, ready.source, reply], {
      env: baseEnv(f, { TERM: "xterm-256color", COLUMNS: "120", LINES: "40" }),
    });
    let output = "";
    child.stdout.on("data", (chunk) => output += chunk);
    child.stderr.on("data", (chunk) => output += chunk);
    child.on("close", (code) => done({ code, output }));
  });
}

export async function waitFor(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
  throw new Error("condition was not met before timeout");
}

export interface Gate {
  server: Server;
  port: number;
  release: () => void;
  responses: string[];
  requests: string[];
}

export function repointModel(f: Fixture, port: number): void {
  writeFileSync(join(f.home, ".pi", "agent", "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", models: [{ id: "fake-model", name: "Fake", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 512 }] } } }));
}

export function lastUserPrompt(f: Fixture | Gate, index = -1): string {
  const requests = (f as Gate).requests ?? (f as Fixture).model.requests;
  const payload = JSON.parse(requests.at(index)!);
  return JSON.stringify(payload.messages.at(-1).content);
}
