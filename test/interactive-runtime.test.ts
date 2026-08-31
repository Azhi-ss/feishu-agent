import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { InteractiveMode, SessionManager } from "@earendil-works/pi-coding-agent";
import { projectKeyFor } from "../src/policy.js";
import { runInteractive } from "../src/runtime.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "dist/src/cli.js");

interface PtyAction { wait: string; send: string; }

function runPty(cwd: string, args: string[], env: NodeJS.ProcessEnv, actions: PtyAction[]): Promise<{ code: number | null; output: string }> {
  const python = `import json,os,pty,select,sys,time\nactions=json.loads(sys.argv[4]); pid,fd=pty.fork()\nif pid==0:\n os.chdir(sys.argv[1]); os.execvpe(sys.argv[2],[sys.argv[2],sys.argv[3],*json.loads(sys.argv[5])],os.environ)\nout=b''; checkpoint=0; action=0; end=time.time()+60\nwhile time.time()<end:\n r,_,_=select.select([fd],[],[],0.1)\n if r:\n  try: out+=os.read(fd,65536)\n  except OSError:\n   _,status=os.waitpid(pid,0); print(out.decode('utf-8','replace')); sys.exit(os.waitstatus_to_exitcode(status))\n if action<len(actions) and actions[action]['wait'].encode() in out[checkpoint:]:\n  time.sleep(.15); os.write(fd,actions[action]['send'].encode()); checkpoint=len(out); action+=1\n p,status=os.waitpid(pid,os.WNOHANG)\n if p:\n  print(out.decode('utf-8','replace')); sys.exit(os.waitstatus_to_exitcode(status) if action==len(actions) else 125)\nos.kill(pid,15); print(out.decode('utf-8','replace')); sys.exit(124)`;
  return new Promise((done) => {
    const child = spawn("python3", ["-c", python, cwd, process.execPath, cli, JSON.stringify(actions), JSON.stringify(args)], { env });
    let output = "";
    child.stdout.on("data", (chunk) => output += chunk);
    child.stderr.on("data", (chunk) => output += chunk);
    child.on("close", (code) => done({ code, output }));
  });
}

function appendSession(sessionDir: string, cwd: string, marker: string): string {
  const manager = SessionManager.create(cwd, sessionDir);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  manager.appendMessage({ role: "user", content: marker, timestamp: Date.now() } as never);
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: `${marker}-ANSWER` }], timestamp: Date.now(), stopReason: "stop", usage, provider: "fake", model: "fake-model" } as never);
  return manager.getSessionFile()!;
}

test("interactive runtime is composed from Pi public TUI API", () => {
  assert.equal(typeof InteractiveMode, "function");
  assert.equal(typeof runInteractive, "function");
});

test("mounted PTY keeps every accepted local workflow project-local, cwd-current, rebound, and non-sharing", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-pty-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const launchCwd = join(project, "current");
  const historicalCwd = join(project, "historical");
  const foreignProject = join(root, "foreign-project");
  const bin = join(root, "bin");
  const extension = join(root, "acceptance-extension");
  const trace = join(root, "trace.log");
  const ghTrace = join(root, "gh.log");
  const exportPath = join(root, "selected-export.html");
  for (const path of [join(home, ".pi", "agent"), join(home, ".feishu-agent"), launchCwd, historicalCwd, foreignProject, bin, extension]) mkdirSync(path, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);

  const requests: Array<{ url?: string; model?: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => body += chunk);
    request.on("end", () => {
      let model: string | undefined;
      try { model = JSON.parse(body).model; } catch {}
      requests.push({ url: request.url, model });
      if (request.url?.endsWith("/chat/completions")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('data: {"choices":[{"delta":{"content":"PTY-PONG"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      } else response.writeHead(404).end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert(address && typeof address !== "string");

  writeFileSync(join(home, ".pi", "agent", "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "fake-key" } }));
  writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", models: [
    { id: "fake-model", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 256 },
    { id: "second-model", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 256 },
  ] } } }));
  const piSettings = "PI-SETTINGS-MUST-NOT-CHANGE";
  writeFileSync(join(home, ".pi", "agent", "settings.json"), piSettings);
  writeFileSync(join(extension, "package.json"), JSON.stringify({ name: "interactive-acceptance", version: "1.0.0", pi: { extensions: ["index.js"] } }));
  writeFileSync(join(extension, "index.js"), `import { appendFileSync } from "node:fs";
export default pi => {
  pi.on("session_start", (_event, ctx) => appendFileSync(process.env.FEISHU_ACCEPTANCE_TRACE, "START|" + ctx.cwd + "|" + ctx.sessionManager.getSessionFile() + "\\n"));
  pi.registerCommand("probe", { description: "record the mounted session", handler: async (_args, ctx) => { const line = "PROBE|" + ctx.cwd + "|" + ctx.sessionManager.getSessionFile(); appendFileSync(process.env.FEISHU_ACCEPTANCE_TRACE, line + "\\n"); ctx.ui.notify(line, "info"); } });
  pi.on("session_before_compact", event => ({ compaction: { summary: "COMPACT-SUMMARY", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } }));
};\n`);
  const feishuSettings = { defaultProvider: "fake", defaultModel: "fake-model", quietStartup: true, collapseChangelog: true, compaction: { keepRecentTokens: 1, reserveTokens: 128 }, packages: [extension] };
  writeFileSync(join(home, ".feishu-agent", "settings.json"), JSON.stringify(feishuSettings));
  writeFileSync(join(home, ".feishu-agent", "SYSTEM.md"), "You are Feishu Agent.\n");
  writeFileSync(join(bin, "lark-cli"), '#!/bin/sh\n[ "$1" = --version ] && { echo "lark-cli 1.0.0"; exit; }\n[ "$*" = "skills list --json" ] && { echo "[]"; exit; }\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$*" >> "${ghTrace}"\nexit 99\n`, { mode: 0o755 });

  const sessionDir = join(home, ".feishu-agent", "sessions", projectKeyFor(project));
  const selectedSession = appendSession(sessionDir, historicalCwd, "PROJECT-RESUME-MARKER");
  const foreignSession = appendSession(join(home, ".feishu-agent", "sessions", projectKeyFor(foreignProject)), foreignProject, "FOREIGN-PROJECT-MARKER");
  const env = { ...process.env, HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}`, TERM: "xterm-256color", COLUMNS: "110", LINES: "32", PI_OFFLINE: "1", FEISHU_ACCEPTANCE_TRACE: trace };

  try {
    const result = await runPty(launchCwd, [], env, [
      { wait: "fake-model", send: "seed-command-marker\r" },
      { wait: "PTY-PONG", send: "/model fake/second-model\r" },
      { wait: "Model: second-model", send: "second-model-prompt\r" },
      { wait: "PTY-PONG", send: `/export ${exportPath}\r` },
      { wait: "Session exported to:", send: "/tree\r" },
      { wait: "second-model-prompt", send: "\r" },
      { wait: "Already at this point", send: "/fork\r" },
      { wait: "Fork from Message", send: "\r" },
      { wait: "Forked to new session", send: "\u0015/probe\r" },
      { wait: `PROBE|${launchCwd}`, send: "/clone\r" },
      { wait: "Cloned to new session", send: "/probe\r" },
      { wait: `PROBE|${launchCwd}`, send: "/new\r" },
      { wait: "New session started", send: "/probe\r" },
      { wait: `PROBE|${launchCwd}`, send: "compact-this-session\r" },
      { wait: "PTY-PONG", send: "/compact\r" },
      { wait: "Compacted from", send: "/resume\r" },
      { wait: "Resume Session", send: "\t" },
      { wait: "Resume Session (All)", send: "PROJECT-RESUME-MARKER" },
      { wait: "PROJECT-RESUME-MARKER", send: "\r" },
      { wait: "PROJECT-RESUME-MARKER-ANSWER", send: "/probe\r" },
      { wait: `PROBE|${launchCwd}`, send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    for (const evidence of ["PTY-PONG", "Model: second-model", "Session exported to:", "Already at this point", "Forked to new session", "Cloned to new session", "New session started", "Compacted from", "PROJECT-RESUME-MARKER-ANSWER"]) assert.match(result.output, new RegExp(evidence));
    assert.doesNotMatch(result.output, /FOREIGN-PROJECT-MARKER/);

    const resumeResult = await runPty(launchCwd, ["-r"], env, [
      { wait: "Resume Session", send: "PROJECT-RESUME-MARKER" },
      { wait: "PROJECT-RESUME-MARKER", send: "\r" },
      { wait: "PROJECT-RESUME-MARKER-ANSWER", send: "/probe\r" },
      { wait: `PROBE|${launchCwd}`, send: "/quit\r" },
    ]);
    assert.equal(resumeResult.code, 0, resumeResult.output);
    assert.doesNotMatch(resumeResult.output, /FOREIGN-PROJECT-MARKER/);
  } finally { server.close(); }

  assert(existsSync(exportPath));
  const exported = readFileSync(exportPath, "utf8");
  assert.match(exported, /Session Export/);
  assert.equal(existsSync(ghTrace), false, "/export must not invoke sharing");
  assert.deepEqual(new Set(requests.map((entry) => entry.url)), new Set(["/v1/chat/completions"]));
  assert(requests.some((entry) => entry.model === "fake-model"));
  assert(requests.some((entry) => entry.model === "second-model"));
  assert.equal(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"), piSettings);
  assert.equal(JSON.parse(readFileSync(join(home, ".feishu-agent", "settings.json"), "utf8")).defaultModel, "fake-model");

  const traceLines = readFileSync(trace, "utf8").trim().split("\n");
  const probes = traceLines.filter((line) => line.startsWith("PROBE|"));
  assert(probes.length >= 5, traceLines.join("\n"));
  assert(probes.every((line) => line.startsWith(`PROBE|${launchCwd}|${sessionDir}/`)), traceLines.join("\n"));
  assert(traceLines.filter((line) => line.startsWith("START|")).every((line) => line.startsWith(`START|${launchCwd}|${sessionDir}/`)), traceLines.join("\n"));
  assert(probes.some((line) => line.endsWith(selectedSession)));
  assert(!probes.some((line) => line.endsWith(foreignSession)));
  assert(readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl")).length >= 4);
});

test("CLI has no reachable JSON or RPC runner", () => {
  for (const args of [["--mode", "json"], ["--mode", "rpc"], ["--json"], ["--rpc"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not supported by Feishu Agent/);
  }
});
