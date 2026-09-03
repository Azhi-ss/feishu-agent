import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { authorizeLarkCommand, userApprovesDestructive } from "../src/high-risk.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "dist/src/cli.js");
const exactCommand = "lark-cli doc delete doc-1 --as user --yes";
const ambiguousCommand = "lark-cli doc delete doc-1 --as user";

function toolResponse(commands: string[], id: string): string {
  const toolCalls = commands.map((command, index) => ({ index, id: `${id}-${index}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }));
  return `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
}

const textResponse = (text: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;

async function fixture(responses: string[]) {
  const root = mkdtempSync(join(tmpdir(), "feishu-high-risk-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const bin = join(root, "bin");
  const trace = join(root, "lark.log");
  for (const path of [join(home, ".pi", "agent"), join(home, ".feishu-agent"), project, bin]) mkdirSync(path, { recursive: true });
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const body = responses.shift();
      if (!body) return response.writeHead(500).end("unexpected model request");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(body);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  writeFileSync(join(home, ".pi", "agent", "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "fake-key" } }));
  writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", models: [{ id: "fake-model", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 256 }] } } }));
  writeFileSync(join(home, ".feishu-agent", "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-model", quietStartup: true, collapseChangelog: true }));
  writeFileSync(join(home, ".feishu-agent", "SYSTEM.md"), "You are Feishu Agent.\n");
  writeFileSync(join(bin, "lark-cli"), `#!/bin/sh
printf 'CALL|%s\n' "$*" >> "$LARK_TRACE"
case "$*" in
 "--version") echo "lark-cli 1.0.0"; exit 0;;
 "skills list --json") echo "[]"; exit 0;;
esac
case " $* " in *" --yes "*) echo "FAKE LARK DELETED"; exit 0;; esac
printf 'FAKE LARK CONFIRMATION: approve destructive write? [y/N] ' >&2
read answer
[ "$answer" = y ] && { echo "FAKE LARK DELETED"; exit 0; }
echo "FAKE LARK CANCELLED" >&2
exit 3
`, { mode: 0o755 });
  return {
    root, home, project, trace, server,
    env: { ...process.env, HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}`, LARK_TRACE: trace, PI_OFFLINE: "1", TERM: "xterm-256color", COLUMNS: "100", LINES: "30" },
  };
}

function larkCalls(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter((line) => !line.endsWith("--version") && !line.endsWith("skills list --json"));
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function runBounded(cwd: string, env: NodeJS.ProcessEnv, args: string[], timeoutMs = 60_000): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr, timedOut }); });
  });
}

function runPty(cwd: string, env: NodeJS.ProcessEnv, prompt: string): Promise<{ code: number | null; output: string }> {
  const python = `import os,pty,select,sys,time\npid,fd=pty.fork()\nif pid==0:\n os.chdir(sys.argv[1]); os.execvpe(sys.argv[2],[sys.argv[2],sys.argv[3]],os.environ)\nout=b''; sent_prompt=False; sent_no=False; sent_quit=False; end=time.time()+60\nwhile time.time()<end:\n r,_,_=select.select([fd],[],[],0.1)\n if r:\n  try: out+=os.read(fd,65536)\n  except OSError:\n   _,status=os.waitpid(pid,0); print(out.decode('utf-8','replace')); sys.exit(os.waitstatus_to_exitcode(status))\n if not sent_prompt and b'fake-model' in out:\n  time.sleep(.3); os.write(fd,sys.argv[4].encode()+b'\\r'); sent_prompt=True\n if sent_prompt and not sent_no and b'FAKE LARK CONFIRMATION' in out:\n  os.write(fd,b'n\\r'); sent_no=True\n if sent_no and not sent_quit and b'AMBIGUOUS-DONE' in out:\n  os.write(fd,b'/quit\\r'); sent_quit=True\n p,status=os.waitpid(pid,os.WNOHANG)\n if p:\n  print(out.decode('utf-8','replace')); sys.exit(os.waitstatus_to_exitcode(status) if sent_quit else 125)\nos.kill(pid,15); print(out.decode('utf-8','replace')); sys.exit(124)`;
  return new Promise((done) => {
    const child = spawn("python3", ["-c", python, cwd, process.execPath, cli, prompt], { env });
    let output = "";
    child.stdout.on("data", (chunk) => output += chunk);
    child.stderr.on("data", (chunk) => output += chunk);
    child.on("close", (code) => done({ code, output }));
  });
}

test("guard unit: destructive --yes allowed only when current user turn names a destructive action", () => {
  assert.equal(userApprovesDestructive("delete doc-1"), true);
  assert.equal(userApprovesDestructive("把那个文档删掉，删除 doc-1"), true);
  assert.equal(userApprovesDestructive("直接执行吧"), false);
  assert.equal(userApprovesDestructive("整理一下文档"), false);

  authorizeLarkCommand(exactCommand, true, false);
  // Approval is turn-scoped, not one-shot: reruns in the same turn stay allowed.
  authorizeLarkCommand(exactCommand, true, true);
  authorizeLarkCommand(`${exactCommand} && echo done`, true, true);

  assert.throws(() => authorizeLarkCommand(exactCommand, false, false), /Blocked lark-cli --yes/);
  assert.throws(() => authorizeLarkCommand(exactCommand, false, true), /rerun with --yes/);
  assert.throws(() => authorizeLarkCommand(`${exactCommand} && lark-cli doc delete doc-2 --as user --yes`, false, true), /Blocked lark-cli --yes/);

  // No --yes: Print fast-fails without hanging; TUI passes through to lark-cli's own prompt.
  assert.throws(() => authorizeLarkCommand(ambiguousCommand, true, true), /High-risk lark-cli/);
  authorizeLarkCommand(ambiguousCommand, false, false);

  // Non-destructive lark-cli writes and unrelated commands are never the guard's business.
  authorizeLarkCommand("lark-cli im messages send --chat-id oc_1 --yes", false, true);
  authorizeLarkCommand("rm -rf /tmp/whatever", false, true);
});

test("Print: explicit destructive request drives one fake-model lark-cli --yes execution", async () => {
  const f = await fixture([toolResponse([exactCommand], "exact-1"), textResponse("EXACT-DONE")]);
  try {
    const result = await runBounded(f.project, f.env, ["-p", "delete doc-1 as user"]);
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /EXACT-DONE/);
    assert.deepEqual(larkCalls(f.trace), ["CALL|doc delete doc-1 --as user --yes"]);
  } finally { await closeServer(f.server); }
});

test("Print: vague request cannot authorize model-added --yes and fails nonzero with guidance", async () => {
  const f = await fixture([toolResponse([exactCommand], "vague-1")]);
  try {
    const result = await runBounded(f.project, f.env, ["-p", "整理一下文档"]);
    assert.equal(result.timedOut, false);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, /Blocked lark-cli --yes/);
    assert.deepEqual(larkCalls(f.trace), []);
  } finally { await closeServer(f.server); }
});

test("Print: destructive write without --yes fast-fails nonzero instead of hanging on confirmation", async () => {
  const f = await fixture([toolResponse([ambiguousCommand], "noyes-1")]);
  try {
    const result = await runBounded(f.project, f.env, ["-p", "delete the document"]);
    assert.equal(result.timedOut, false);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, /High-risk lark-cli|rerun with --yes/);
    assert.deepEqual(larkCalls(f.trace), []);
  } finally { await closeServer(f.server); }
});

test("Print: approval is turn-scoped — two --yes deletes in one turn both execute", async () => {
  const second = "lark-cli doc delete doc-2 --as bot --yes";
  const f = await fixture([toolResponse([exactCommand, second], "multi-1"), textResponse("MULTI-DONE")]);
  try {
    const result = await runBounded(f.project, f.env, ["-p", "delete doc-1 and doc-2"]);
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(larkCalls(f.trace), ["CALL|doc delete doc-1 --as user --yes", "CALL|doc delete doc-2 --as bot --yes"]);
  } finally { await closeServer(f.server); }
});

test("Interactive: vague request omits --yes and visibly reaches fake lark confirmation", async () => {
  const f = await fixture([toolResponse([ambiguousCommand], "interactive-1"), textResponse("AMBIGUOUS-DONE")]);
  try {
    const result = await runPty(f.project, f.env, "整理一下文档");
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /FAKE LARK CONFIRMATION: approve destructive write/);
    assert.match(result.output, /AMBIGUOUS-DONE/);
    assert.deepEqual(larkCalls(f.trace), ["CALL|doc delete doc-1 --as user"]);
  } finally { await closeServer(f.server); }
});
