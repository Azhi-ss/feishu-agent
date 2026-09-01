import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { approvalFromExactRequest, authorizeLarkCommand, extractLarkOperation } from "../src/high-risk.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "dist/src/cli.js");
const exactCommand = "lark-cli doc delete doc-1 --as user --yes";
const ambiguousCommand = "lark-cli doc delete doc-1 --as user";
const metadata = () => ({ risk: "high-risk-write", action: "delete", target: "positional:0", identity: "--as", scope: "one-document" });

function toolResponse(command: string, id: string): string {
  const args = JSON.stringify({ command });
  return `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name: "bash", arguments: args } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
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
 "doc delete --help") printf 'Risk: high-risk-write\nAction: delete\nTarget: positional:0\nIdentity: --as\nScope: one-document\n'; exit 0;;
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
  return readFileSync(path, "utf8").trim().split("\n").filter((line) => !line.endsWith("--help") && !line.endsWith("--version") && !line.endsWith("skills list --json"));
}

function runBounded(cwd: string, env: NodeJS.ProcessEnv, args: string[], timeoutMs = 10000): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
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
  const python = `import os,pty,select,sys,time\npid,fd=pty.fork()\nif pid==0:\n os.chdir(sys.argv[1]); os.execvpe(sys.argv[2],[sys.argv[2],sys.argv[3]],os.environ)\nout=b''; sent_prompt=False; sent_no=False; sent_quit=False; end=time.time()+15\nwhile time.time()<end:\n r,_,_=select.select([fd],[],[],0.1)\n if r:\n  try: out+=os.read(fd,65536)\n  except OSError:\n   _,status=os.waitpid(pid,0); print(out.decode('utf-8','replace')); sys.exit(os.waitstatus_to_exitcode(status))\n if not sent_prompt and b'fake-model' in out:\n  time.sleep(.3); os.write(fd,sys.argv[4].encode()+b'\\r'); sent_prompt=True\n if sent_prompt and not sent_no and b'FAKE LARK CONFIRMATION' in out:\n  os.write(fd,b'n\\r'); sent_no=True\n if sent_no and not sent_quit and b'AMBIGUOUS-DONE' in out:\n  os.write(fd,b'/quit\\r'); sent_quit=True\n p,status=os.waitpid(pid,os.WNOHANG)\n if p:\n  print(out.decode('utf-8','replace')); sys.exit(os.waitstatus_to_exitcode(status) if sent_quit else 125)\nos.kill(pid,15); print(out.decode('utf-8','replace')); sys.exit(124)`;
  return new Promise((done) => {
    const child = spawn("python3", ["-c", python, cwd, process.execPath, cli, prompt], { env });
    let output = "";
    child.stdout.on("data", (chunk) => output += chunk);
    child.stderr.on("data", (chunk) => output += chunk);
    child.on("close", (code) => done({ code, output }));
  });
}

test("lark-cli --yes approval is derived from exact English/Chinese requests and consumed once", () => {
  const approval = approvalFromExactRequest("delete doc-1 as user for one-document");
  assert.deepEqual(approval, { action: "delete", target: "doc-1", identity: "user", scope: "one-document", consumed: false });
  authorizeLarkCommand(exactCommand, approval, false, metadata);
  assert.throws(() => authorizeLarkCommand(exactCommand, approval, false, metadata), /exact one-shot approval/);
  assert.throws(() => authorizeLarkCommand("lark-cli doc delete doc-2 --as user --yes", approvalFromExactRequest("delete doc-1 as user for one-document"), false, metadata), /required/);
  assert.throws(() => authorizeLarkCommand("lark-cli doc delete doc-1 --as bot --yes", approvalFromExactRequest("delete doc-1 as user for one-document"), false, metadata), /required/);
  assert.throws(() => authorizeLarkCommand(`${exactCommand} && lark-cli doc delete doc-2 --as user --yes`, approvalFromExactRequest("delete doc-1 as user for one-document"), false, metadata), /required/);
  assert.throws(() => authorizeLarkCommand(exactCommand, undefined, false, metadata), /Print mode cannot prompt/);
  assert.throws(() => authorizeLarkCommand(ambiguousCommand, undefined, true, metadata), /High-risk Approval required/);
  assert.deepEqual(approvalFromExactRequest("请以用户身份在one-document范围内删除doc-1"), { action: "delete", target: "doc-1", identity: "user", scope: "one-document", consumed: false });
  assert.deepEqual(extractLarkOperation("lark-cli im messages delete --message-id om_1 --as user --yes"), { action: "delete", target: "om_1", identity: "user", scope: "im.messages.delete" });
  assert.equal(approvalFromExactRequest("delete the document"), undefined);
});

test("exact natural Print request drives one matching fake-model lark-cli --yes execution", async () => {
  const f = await fixture([toolResponse(exactCommand, "exact-1"), textResponse("EXACT-DONE")]);
  try {
    const result = await runBounded(f.project, f.env, ["-p", "delete doc-1 as user for one-document"]);
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /EXACT-DONE/);
    assert.deepEqual(larkCalls(f.trace), ["CALL|doc delete doc-1 --as user --yes"]);
  } finally { f.server.close(); }
});

test("vague natural request missing scope cannot authorize model-added --yes", async () => {
  const f = await fixture([toolResponse(exactCommand, "missing-scope-1")]);
  try {
    const result = await runBounded(f.project, f.env, ["-p", "delete doc-1 as user"]);
    assert.equal(result.timedOut, false);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, /exact one-shot approval|required/);
    assert.deepEqual(larkCalls(f.trace), []);
  } finally { f.server.close(); }
});

test("changed approval fields, chaining, and reuse are blocked before another fake lark execution", async (t) => {
  const variants = [
    ["target", "lark-cli doc delete doc-2 --as user --yes"],
    ["identity", "lark-cli doc delete doc-1 --as bot --yes"],
    ["second target", "lark-cli doc delete doc-1 doc-2 --as user --yes"],
    ["second scope", "lark-cli doc delete doc-1 --as user --as bot --yes"],
    ["env wrapper", "env X=1 lark-cli doc delete doc-2 --as user --yes"],
    ["chaining", `${exactCommand} && lark-cli doc delete doc-2 --as user --yes`],
  ] as const;
  for (const [name, command] of variants) await t.test(name, async () => {
    const f = await fixture([toolResponse(command, `changed-${name}`)]);
    try {
      const result = await runBounded(f.project, f.env, ["-p", "delete doc-1 as user for one-document"]);
      assert.equal(result.timedOut, false);
      assert.notEqual(result.code, 0);
      assert.match(result.stdout + result.stderr, /exact one-shot approval|required/);
      assert.deepEqual(larkCalls(f.trace), []);
    } finally { f.server.close(); }
  });

  await t.test("reuse", async () => {
    const f = await fixture([toolResponse(exactCommand, "reuse-1"), toolResponse(exactCommand, "reuse-2")]);
    try {
      const result = await runBounded(f.project, f.env, ["-p", "delete doc-1 as user for one-document"]);
      assert.equal(result.timedOut, false);
      assert.notEqual(result.code, 0);
      assert.match(result.stdout + result.stderr, /exact one-shot approval|required/);
      assert.deepEqual(larkCalls(f.trace), ["CALL|doc delete doc-1 --as user --yes"]);
    } finally { f.server.close(); }
  });
});

test("ambiguous Interactive request omits --yes and visibly reaches fake lark confirmation", async () => {
  const f = await fixture([toolResponse(ambiguousCommand, "interactive-1"), textResponse("AMBIGUOUS-DONE")]);
  try {
    const result = await runPty(f.project, f.env, "delete the document");
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /FAKE LARK CONFIRMATION: approve destructive write/);
    assert.match(result.output, /AMBIGUOUS-DONE/);
    assert.deepEqual(larkCalls(f.trace), ["CALL|doc delete doc-1 --as user"]);
  } finally { f.server.close(); }
});

test("incomplete or compound Print high-risk writes fail nonzero without entering fake confirmation", async (t) => {
  const variants = [
    ["complete", ambiguousCommand],
    ["missing identity", "lark-cli doc delete doc-1"],
    ["missing target", "lark-cli doc delete --as user"],
    ["env wrapper", `env X=1 ${ambiguousCommand}`],
    ["compound", `${ambiguousCommand} | cat`],
  ] as const;
  for (const [name, command] of variants) await t.test(name, async () => {
    const f = await fixture([toolResponse(command, `print-${name}`)]);
    try {
      const result = await runBounded(f.project, f.env, ["-p", "delete the document"], 3000);
      assert.equal(result.timedOut, false, `${result.stdout}\n${result.stderr}`);
      assert.notEqual(result.code, 0);
      assert.match(result.stdout + result.stderr, /approval.*required|cannot prompt|exact one-shot/i);
      assert.deepEqual(larkCalls(f.trace), []);
    } finally { f.server.close(); }
  });
});
