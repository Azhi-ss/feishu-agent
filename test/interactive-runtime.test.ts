import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { runInteractive } from "../src/runtime.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "dist/src/cli.js");

test("interactive runtime is composed from Pi public TUI API", () => {
  assert.equal(typeof InteractiveMode, "function");
  assert.equal(typeof runInteractive, "function");
});

test("mounted pseudo-terminal reaches Feishu TUI, submits a fake-model prompt, and exits cleanly", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-pty-")); const home = join(root, "home"); const project = join(root, "project"); const bin = join(root, "bin");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true }); mkdirSync(join(home, ".feishu-agent"), { recursive: true }); mkdirSync(project, { recursive: true }); mkdirSync(bin, { recursive: true });
  const server = createServer((request, response) => {
    if (request.url?.endsWith("/chat/completions")) { response.writeHead(200, { "content-type": "text/event-stream" }); response.end('data: {"choices":[{"delta":{"content":"PTY-PONG"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); }
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  writeFileSync(join(home, ".pi", "agent", "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "fake-key" } }));
  writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", models: [{ id: "fake-model", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 256 }] } } }));
  writeFileSync(join(home, ".feishu-agent", "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-model", quietStartup: true, collapseChangelog: true }));
  writeFileSync(join(home, ".feishu-agent", "SYSTEM.md"), "You are Feishu Agent.\n");
  writeFileSync(join(bin, "lark-cli"), '#!/bin/sh\n[ "$1" = --version ] && { echo "lark-cli 1.0.0"; exit; }\n[ "$*" = "skills list --json" ] && { echo "[]"; exit; }\nexit 0\n', { mode: 0o755 });
  const python = `import os,pty,select,sys,time,re\npid,fd=pty.fork()\nif pid==0:\n os.chdir(sys.argv[1]); os.execvpe(sys.argv[2],[sys.argv[2],sys.argv[3]],os.environ)\nout=b''; sent=False; quit_sent=False; ready_at=None; end=time.time()+30\nwhile time.time()<end:\n r,_,_=select.select([fd],[],[],0.2)\n if r:\n  try: out+=os.read(fd,65536)\n  except OSError:\n   _,status=os.waitpid(pid,0); print(out.decode('utf-8','replace')); sys.exit(os.waitstatus_to_exitcode(status))\n if ready_at is None and b'fake-model' in out: ready_at=time.time()\n if ready_at and not sent and time.time()-ready_at>1: os.write(fd,b'hello from pty\\r'); sent=True\n if sent and b'PTY-PONG' in out and not quit_sent: os.write(fd,b'/quit\\r'); quit_sent=True\n p,status=os.waitpid(pid,os.WNOHANG)\n if p: print(out.decode('utf-8','replace')); sys.exit(os.waitstatus_to_exitcode(status))\nos.kill(pid,15); print(out.decode('utf-8','replace')); sys.exit(124)`;
  const result = await new Promise<{ code: number | null; output: string }>((done) => {
    const child = spawn("python3", ["-c", python, project, process.execPath, cli], { env: { ...process.env, HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}`, TERM: "xterm-256color", COLUMNS: "100", LINES: "30", PI_OFFLINE: "1" } });
    let output = ""; child.stdout.on("data", (chunk) => output += chunk); child.stderr.on("data", (chunk) => output += chunk); child.on("close", (code) => done({ code, output }));
  });
  server.close();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /PTY-PONG/);
  assert(readdirSync(join(home, ".feishu-agent", "sessions"), { recursive: true }).some((name) => String(name).endsWith(".jsonl")));
});
