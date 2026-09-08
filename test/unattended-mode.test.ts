import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hermeticEnv } from "./helpers/hermetic-env.js";
import { writeMemoryConfig } from "../src/memory.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "dist/src/cli.js");
const apiKeySentinel = "MEM0-API-KEY-SENTINEL-31";

const textResponse = (text: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;

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

function fixture(modelUrl: string) {
  const root = mkdtempSync(join(tmpdir(), "feishu-unattended-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const pi = join(home, ".pi", "agent");
  const feishu = join(home, ".feishu-agent");
  mkdirSync(pi, { recursive: true });
  mkdirSync(feishu, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(pi, "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "not-secret" } }));
  writeFileSync(join(pi, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: modelUrl, api: "openai-completions", models: [{ id: "fake-model", name: "Fake", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 256 }] } } }));
  writeFileSync(join(feishu, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-model", quietStartup: true, collapseChangelog: true }));
  writeFileSync(join(feishu, "SYSTEM.md"), "You are Feishu Agent.\n");
  writeMemoryConfig(feishu, "alice");
  return { root, home, cwd, feishu };
}

function run(cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [cli, "-p", "ping"], { cwd, env });
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

test("FEISHU_UNATTENDED=1 print run completes a model turn without touching Mem0 or needing MEM0_API_KEY", async () => {
  const mem0Hits: string[] = [];
  const modelServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(textResponse("unattended-pong"));
  });
  const mem0Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => body += chunk);
    request.on("end", () => {
      mem0Hits.push(`${request.method} ${request.url}\n${body}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}');
    });
  });
  await Promise.all([
    new Promise<void>((done) => modelServer.listen(0, "127.0.0.1", done)),
    new Promise<void>((done) => mem0Server.listen(0, "127.0.0.1", done)),
  ]);
  const modelAddress = modelServer.address();
  const mem0Address = mem0Server.address();
  assert(modelAddress && typeof modelAddress !== "string" && mem0Address && typeof mem0Address !== "string");
  const f = fixture(`http://127.0.0.1:${modelAddress.port}/v1`);
  try {
    const env = hermeticEnv({
      HOME: f.home,
      PI_OFFLINE: "1",
      FEISHU_UNATTENDED: "1",
      MEM0_API_HOST: `http://127.0.0.1:${mem0Address.port}`,
    });
    delete env.MEM0_API_KEY;
    const result = await run(f.cwd, env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /unattended-pong/);
    assert.deepEqual(mem0Hits, [], "unattended run issued Mem0 requests");
    assert.doesNotMatch(result.stderr, /Long-term Memory/i, "unattended run emitted a memory warning");
    assert.doesNotMatch(result.stderr, /MEM0_API_KEY/);
  } finally {
    await Promise.all([closeServer(modelServer), closeServer(mem0Server)]);
  }
});

test("print run without FEISHU_UNATTENDED keeps the normal memory flow (ping, recall, capture)", async () => {
  const mem0Hits: string[] = [];
  const modelServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(textResponse("attended-pong"));
  });
  const mem0Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => body += chunk);
    request.on("end", () => {
      mem0Hits.push(`${request.method} ${request.url}`);
      if (request.url?.endsWith("/v1/ping/")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"status":"ok"}');
      } else if (request.url?.includes("/search/")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"results":[]}');
      } else if (request.url?.includes("/add/")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("[]");
      } else if (request.url?.startsWith("/v1/memories/")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"results":[],"count":0}');
      } else {
        response.writeHead(404).end();
      }
    });
  });
  await Promise.all([
    new Promise<void>((done) => modelServer.listen(0, "127.0.0.1", done)),
    new Promise<void>((done) => mem0Server.listen(0, "127.0.0.1", done)),
  ]);
  const modelAddress = modelServer.address();
  const mem0Address = mem0Server.address();
  assert(modelAddress && typeof modelAddress !== "string" && mem0Address && typeof mem0Address !== "string");
  const f = fixture(`http://127.0.0.1:${modelAddress.port}/v1`);
  try {
    const env = hermeticEnv({
      HOME: f.home,
      PI_OFFLINE: "1",
      MEM0_API_KEY: apiKeySentinel,
      MEM0_API_HOST: `http://127.0.0.1:${mem0Address.port}`,
    });
    const result = await run(f.cwd, env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /attended-pong/);
    assert(mem0Hits.some((hit) => hit.endsWith("/v1/ping/")), `no health ping; hits: ${mem0Hits.join(", ")}`);
    assert(mem0Hits.some((hit) => hit.includes("/search/")), `no recall search; hits: ${mem0Hits.join(", ")}`);
    assert(mem0Hits.some((hit) => hit.includes("/add/")), `no turn-end capture; hits: ${mem0Hits.join(", ")}`);
    assert.doesNotMatch([result.stdout, result.stderr].join("\n"), new RegExp(apiKeySentinel));
  } finally {
    await Promise.all([closeServer(modelServer), closeServer(mem0Server)]);
  }
});
