import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hermeticEnv } from "./helpers/hermetic-env.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "dist/src/cli.js");

function fixture(baseUrl: string) {
  const root = mkdtempSync(join(tmpdir(), "feishu-model-"));
  const home = join(root, "home");
  const cwd = join(root, "project", "nested");
  const pi = join(home, ".pi", "agent");
  const feishu = join(home, ".feishu-agent");
  mkdirSync(pi, { recursive: true });
  mkdirSync(feishu, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(pi, "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "not-secret" } }));
  writeFileSync(join(pi, "models.json"), JSON.stringify({ providers: { fake: { baseUrl, api: "openai-completions", models: [{ id: "fake-model", name: "Fake", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 1024 }] } } }));
  writeFileSync(join(pi, "settings.json"), JSON.stringify({ defaultProvider: "pi-provider", defaultModel: "pi-model" }));
  writeFileSync(join(feishu, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-model" }));
  return { home, cwd, pi, feishu };
}

function runAsync(cwd: string, home: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: hermeticEnv({ HOME: home, PI_OFFLINE: "1" }) });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}

test("print mode uses shared read-only auth and isolated Feishu default", async () => {
  const server = createServer((request, response) => {
    if (request.url?.endsWith("/chat/completions")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"pong"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    } else { response.writeHead(404).end(); }
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert(address && typeof address !== "string");
  const f = fixture(`http://127.0.0.1:${address.port}/v1`);
  const before = ["auth.json", "models.json", "settings.json"].map((name) => readFileSync(join(f.pi, name), "utf8"));
  try {
    const result = await runAsync(f.cwd, f.home, ["-p", "ping"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /pong/);
    assert.deepEqual(["auth.json", "models.json", "settings.json"].map((name) => readFileSync(join(f.pi, name), "utf8")), before);
  } finally { server.close(); }
});

test("print mode sends a literal /resume prompt instead of invoking the Interactive selector", async () => {
  let prompt = "";
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => body += chunk);
    request.on("end", () => {
      try { prompt = JSON.parse(body).messages.at(-1)?.content ?? ""; } catch {}
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"literal-resume-response"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  const f = fixture(`http://127.0.0.1:${address.port}/v1`);
  try {
    const result = await runAsync(f.cwd, f.home, ["-p", "/resume"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /literal-resume-response/);
    assert.deepEqual(prompt, [{ type: "text", text: "/resume" }]);
    assert.doesNotMatch(result.stderr, /Extension error|ui\.custom/);
  } finally { server.close(); }
});

test("print mode fails before prompting when a configured Feishu default is stale", () => {
  const f = fixture("http://127.0.0.1:1/v1");
  const piBefore = ["auth.json", "models.json", "settings.json"].map((name) => readFileSync(join(f.pi, name)));
  writeFileSync(join(f.feishu, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "removed-model" }));
  const result = spawnSync(process.execPath, [cli, "-p", "ping"], { cwd: f.cwd, encoding: "utf8", env: hermeticEnv({ HOME: f.home, PI_OFFLINE: "1" }) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /configured Feishu default fake\/removed-model is unavailable/i);
  assert.match(result.stderr, /feishu init --reset-model/i);
  assert.deepEqual(["auth.json", "models.json", "settings.json"].map((name) => readFileSync(join(f.pi, name))), piBefore);
});

test("print mode fails before prompting when no authenticated model exists", () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-no-model-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(join(home, ".feishu-agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "auth.json"), "{}");
  const result = spawnSync(process.execPath, [cli, "-p", "ping"], { cwd: root, encoding: "utf8", env: hermeticEnv({ HOME: home, PI_OFFLINE: "1" }) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No authenticated model is available/);
});
