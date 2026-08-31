import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, lstatSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "dist/src/cli.js");

function run(cwd: string, env: NodeJS.ProcessEnv, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env }); let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk); child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

function files(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name); if (lstatSync(path).isSymbolicLink()) continue; if (statSync(path).isDirectory()) out.push(...files(path)); else out.push(path);
  }
  return out;
}

test("fresh HOME CLI init is idempotent and immediately ready for Print without project .pi or secret leakage", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-init-cli-")); const home = join(root, "home"); const project = join(root, "project"); const bin = join(root, "bin");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true }); mkdirSync(project, { recursive: true }); mkdirSync(bin, { recursive: true });
  const secret = "MEM0-SENTINEL-KEY";
  writeFileSync(join(home, ".pi", "agent", "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "fake-model-key" } }));
  const modelServer = createServer((request, response) => {
    if (request.url?.endsWith("/chat/completions")) { response.writeHead(200, { "content-type": "text/event-stream" }); response.end('data: {"choices":[{"delta":{"content":"pong"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); }
    else response.writeHead(404).end();
  });
  const mem0Server = createServer((request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(request.url === "/v1/ping/" ? '{"status":"ok"}' : request.url === "/v1/memories/" ? '{"results":[]}' : '{}'); });
  await Promise.all([new Promise<void>((r) => modelServer.listen(0, "127.0.0.1", r)), new Promise<void>((r) => mem0Server.listen(0, "127.0.0.1", r))]);
  const modelAddress = modelServer.address(); const mem0Address = mem0Server.address(); assert(modelAddress && typeof modelAddress !== "string" && mem0Address && typeof mem0Address !== "string");
  writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`, api: "openai-completions", models: [{ id: "fake-model", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 256 }] } } }));
  writeFileSync(join(bin, "lark-cli"), '#!/bin/sh\ncase "$*" in\n "doctor") echo "doctor ok";;\n "--version") echo "lark-cli 9.9.9";;\n "skills list --json") echo "[\\"docs\\"]";;\n "skills read docs") printf -- "---\\nname: docs\\ndescription: official docs\\n---\\nbody\\n";;\n *) exit 2;;\nesac\n', { mode: 0o755 });
  writeFileSync(join(bin, "fake-npm"), `#!/bin/sh\nset -eu\nif [ "$1" = install ]; then\n  prefix=""\n  while [ "$#" -gt 0 ]; do [ "$1" = --prefix ] && { prefix="$2"; break; }; shift; done\n  mkdir -p "$prefix/node_modules/@mem0"\n  ln -s "${join(repoRoot, "node_modules", "@mem0", "pi-agent-plugin")}" "$prefix/node_modules/@mem0/pi-agent-plugin"\n  printf '{"dependencies":{"@mem0/pi-agent-plugin":"0.1.5"}}' > "$prefix/package.json"\n  exit 0\nfi\nexit 0\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}`, MEM0_API_KEY: secret, MEM0_API_HOST: `http://127.0.0.1:${mem0Address.port}`, PI_OFFLINE: "1" };
  try {
    const firstHome = join(home, ".feishu-agent");
    mkdirSync(firstHome, { recursive: true });
    writeFileSync(join(firstHome, "settings.json"), JSON.stringify({ npmCommand: [join(bin, "fake-npm")] }));
    const first = await run(project, env, ["init", "--identity", "alice", "--model", "fake/fake-model", "--thinking", "medium"]);
    assert.equal(first.code, 0, first.stderr); assert.match(first.stdout, /Memory Identity: feishu:alice/); assert.match(first.stdout, /Official Skills: lark-cli 9\.9\.9/); assert.doesNotMatch(first.stdout + first.stderr, new RegExp(secret));
    const settings = JSON.parse(readFileSync(join(home, ".feishu-agent", "settings.json"), "utf8")); assert.equal(settings.defaultThinkingLevel, "medium"); assert.equal(settings.packages.filter((entry: string) => entry.includes("@mem0/pi-agent-plugin")).length, 1);
    const print = await run(project, env, ["-p", "ping"]); assert.equal(print.code, 0, print.stderr); assert.match(print.stdout, /pong/);
    const second = await run(project, env, ["init", "--identity", "bob", "--model", "fake/fake-model"]); assert.equal(second.code, 0, second.stderr); assert.match(second.stdout, /Memory Identity: feishu:alice/);
    const rerunSettings = JSON.parse(readFileSync(join(home, ".feishu-agent", "settings.json"), "utf8")); assert.equal(rerunSettings.packages.filter((entry: string) => entry.includes("@mem0/pi-agent-plugin")).length, 1);
    assert.equal(statSync(join(project, ".pi"), { throwIfNoEntry: false }), undefined);
    for (const path of files(join(home, ".feishu-agent"))) assert.doesNotMatch(readFileSync(path).toString(), new RegExp(secret), path);
  } finally { modelServer.close(); mem0Server.close(); }
});
