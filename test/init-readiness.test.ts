import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkReadiness } from "../src/readiness.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "dist/src/cli.js");

function run(cwd: string, env: NodeJS.ProcessEnv, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

function publicFixture(models: string[] = ["one", "two"]) {
  const root = mkdtempSync(join(tmpdir(), "feishu-public-readiness-"));
  const home = join(root, "home"), project = join(root, "project"), bin = join(root, "bin");
  const pi = join(home, ".pi", "agent"), agent = join(home, ".feishu-agent"), lark = join(home, ".config", "lark-cli");
  mkdirSync(pi, { recursive: true }); mkdirSync(agent, { recursive: true }); mkdirSync(project, { recursive: true }); mkdirSync(bin, { recursive: true }); mkdirSync(lark, { recursive: true });
  writeFileSync(join(pi, "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "model-secret" } }));
  writeFileSync(join(pi, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", models: models.map((id) => ({ id, reasoning: true, input: ["text"], contextWindow: 4096, maxTokens: 256 })) } } }));
  writeFileSync(join(pi, "settings.json"), '{"defaultProvider":"pi","defaultModel":"pi-model"}\n');
  writeFileSync(join(lark, "config.json"), '{"defaultProfile":"personal"}\n');
  writeFileSync(join(lark, "token.json"), '{"token":"lark-secret"}\n');
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: ["npm:@mem0/pi-agent-plugin@0.1.5"] }) + "\n");
  return { root, home, project, bin, pi, agent, lark };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

function fakeLark(bin: string, body = 'case "$*" in "doctor") exit 0;; "--version") echo "lark-cli test";; "skills list --json") echo "[]";; *) exit 2;; esac') {
  writeFileSync(join(bin, "lark-cli"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

test("public init requires explicit model selection and preserves shared bytes and the existing Feishu default until reset", async () => {
  const f = publicFixture(); fakeLark(f.bin, 'case "$*" in "doctor") [ "$LARK_PROFILE" = finance ];; "--version") echo "lark-cli test";; "skills list --json") echo "[]";; *) exit 2;; esac');
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end('{"status":"ok"}'); });
  const host = await listen(server);
  const invariantPaths = [join(f.pi, "auth.json"), join(f.pi, "models.json"), join(f.pi, "settings.json"), join(f.lark, "config.json"), join(f.lark, "token.json")];
  const before = invariantPaths.map((path) => readFileSync(path));
  const env = { ...process.env, HOME: f.home, PATH: `${f.bin}${delimiter}${process.env.PATH}`, MEM0_API_KEY: "mem0-secret", MEM0_API_HOST: host, PI_OFFLINE: "1" };
  try {
    const single = publicFixture(["one"]); fakeLark(single.bin);
    const singleResult = await run(single.project, { ...env, HOME: single.home, PATH: `${single.bin}${delimiter}${process.env.PATH}` }, ["init", "--identity", "alice"]);
    assert.notEqual(singleResult.code, 0); assert.match(singleResult.stderr, /Select an authenticated model explicitly/);

    const ambiguous = await run(f.project, env, ["init", "--identity", "alice"]);
    assert.notEqual(ambiguous.code, 0); assert.match(ambiguous.stderr, /Select an authenticated model explicitly/);

    const first = await run(f.project, env, ["init", "--identity", "alice", "--model", "fake/two", "--thinking", "medium", "--lark-profile", "finance"]);
    assert.equal(first.code, 0, first.stderr); assert.match(first.stdout, /Model: fake\/two/);
    let settings = JSON.parse(readFileSync(join(f.agent, "settings.json"), "utf8"));
    assert.deepEqual({ provider: settings.defaultProvider, model: settings.defaultModel, thinking: settings.defaultThinkingLevel }, { provider: "fake", model: "two", thinking: "medium" });

    const preserved = await run(f.project, env, ["init", "--identity", "alice", "--model", "fake/one", "--thinking", "high", "--lark-profile", "finance"]);
    assert.equal(preserved.code, 0, preserved.stderr); assert.match(preserved.stdout, /Model: fake\/two/);
    settings = JSON.parse(readFileSync(join(f.agent, "settings.json"), "utf8"));
    assert.deepEqual({ model: settings.defaultModel, thinking: settings.defaultThinkingLevel }, { model: "two", thinking: "medium" });

    delete settings.defaultThinkingLevel;
    writeFileSync(join(f.agent, "settings.json"), JSON.stringify(settings) + "\n");
    const filledThinking = await run(f.project, env, ["init", "--identity", "alice", "--thinking", "high", "--lark-profile", "finance"]);
    assert.equal(filledThinking.code, 0, filledThinking.stderr); assert.match(filledThinking.stdout, /Model: fake\/two/);
    settings = JSON.parse(readFileSync(join(f.agent, "settings.json"), "utf8"));
    assert.deepEqual({ model: settings.defaultModel, thinking: settings.defaultThinkingLevel }, { model: "two", thinking: "high" });

    const reset = await run(f.project, env, ["init", "--identity", "alice", "--model", "fake/one", "--thinking", "xhigh", "--reset-model", "--lark-profile", "finance"]);
    assert.equal(reset.code, 0, reset.stderr); assert.match(reset.stdout, /Model: fake\/one/);
    settings = JSON.parse(readFileSync(join(f.agent, "settings.json"), "utf8"));
    assert.deepEqual({ model: settings.defaultModel, thinking: settings.defaultThinkingLevel }, { model: "one", thinking: "xhigh" });
    assert.deepEqual(invariantPaths.map((path) => readFileSync(path)), before);
    assert.doesNotMatch(JSON.stringify(settings) + first.stdout + first.stderr + preserved.stdout + preserved.stderr + filledThinking.stdout + filledThinking.stderr + reset.stdout + reset.stderr, /mem0-secret|model-secret|lark-secret/);
  } finally { server.close(); }
});

test("public init reports no models, missing and rejected Mem0, and doctor failure distinctly while keeping non-secret initialized state", async () => {
  const noModels = publicFixture([]); fakeLark(noModels.bin);
  const baseEnv = { ...process.env, HOME: noModels.home, PATH: `${noModels.bin}${delimiter}${process.env.PATH}`, PI_OFFLINE: "1" };
  const noModel = await run(noModels.project, { ...baseEnv, MEM0_API_KEY: "unused" }, ["init", "--identity", "alice", "--model", "fake/one"]);
  assert.notEqual(noModel.code, 0); assert.match(noModel.stderr, /No authenticated model is available; manage credentials through ordinary Pi/);
  assert.match(readFileSync(join(noModels.agent, "mem0-config.json"), "utf8"), /feishu:alice/);

  const f = publicFixture(["one"]); fakeLark(f.bin);
  const env = { ...process.env, HOME: f.home, PATH: `${f.bin}${delimiter}${process.env.PATH}`, PI_OFFLINE: "1" };
  const missing = await run(f.project, env, ["init", "--identity", "alice", "--model", "fake/one"]);
  assert.notEqual(missing.code, 0); assert.match(missing.stderr, /MEM0_API_KEY is missing/);
  assert.match(readFileSync(join(f.agent, "mem0-config.json"), "utf8"), /feishu:alice/);

  const rejectedServer = createServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end('{"status":"error","message":"rejected TEST-REJECTED-KEY"}'); });
  const rejectedHost = await listen(rejectedServer);
  try {
    const rejected = await run(f.project, { ...env, MEM0_API_KEY: "TEST-REJECTED-KEY", MEM0_API_HOST: rejectedHost }, ["init", "--identity", "alice", "--model", "fake/one"]);
    assert.notEqual(rejected.code, 0); assert.match(rejected.stderr, /Mem0 validation failed/); assert.doesNotMatch(rejected.stdout + rejected.stderr, /TEST-REJECTED-KEY/);
  } finally { rejectedServer.close(); }

  fakeLark(f.bin, 'case "$*" in "doctor") echo "profile finance expired" >&2; exit 7;; *) exit 2;; esac');
  const healthyServer = createServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end('{"status":"ok"}'); });
  const healthyHost = await listen(healthyServer);
  try {
    const doctor = await run(f.project, { ...env, MEM0_API_KEY: "healthy-key", MEM0_API_HOST: healthyHost, LARK_PROFILE: "finance" }, ["init", "--identity", "alice", "--model", "fake/one"]);
    assert.notEqual(doctor.code, 0); assert.match(doctor.stderr, /Lark doctor failed \(exit 7\): profile finance expired/); assert.doesNotMatch(doctor.stderr, /Mem0 validation failed|No authenticated model/);
  } finally { healthyServer.close(); }
});

test("public init rejects a stale existing Feishu default until explicit reset", async () => {
  const f = publicFixture(["one"]); fakeLark(f.bin);
  writeFileSync(join(f.agent, "settings.json"), JSON.stringify({ packages: ["npm:@mem0/pi-agent-plugin@0.1.5"], defaultProvider: "fake", defaultModel: "gone" }) + "\n");
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end('{"status":"ok"}'); });
  const host = await listen(server);
  const env = { ...process.env, HOME: f.home, PATH: `${f.bin}${delimiter}${process.env.PATH}`, MEM0_API_KEY: "healthy-key", MEM0_API_HOST: host, PI_OFFLINE: "1" };
  try {
    const stale = await run(f.project, env, ["init", "--identity", "alice", "--model", "fake/one"]);
    assert.notEqual(stale.code, 0); assert.match(stale.stderr, /Existing Feishu default is unavailable: fake\/gone.*--reset-model/);
    assert.equal(JSON.parse(readFileSync(join(f.agent, "settings.json"), "utf8")).defaultModel, "gone");

    const reset = await run(f.project, env, ["init", "--identity", "alice", "--model", "fake/one", "--reset-model"]);
    assert.equal(reset.code, 0, reset.stderr); assert.match(reset.stdout, /Model: fake\/one/);
  } finally { server.close(); }
});

test("readiness selects authenticated Feishu model, thinking preference, and runs doctor without changing shared files", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-ready-")); const home = join(root, "home"); const pi = join(home, ".pi", "agent"); const agent = join(home, ".feishu-agent"); const bin = join(root, "bin");
  mkdirSync(pi, { recursive: true }); mkdirSync(agent, { recursive: true }); mkdirSync(bin, { recursive: true });
  writeFileSync(join(pi, "auth.json"), '{"fake":{"type":"api_key","key":"safe-fake"}}');
  writeFileSync(join(pi, "models.json"), '{"providers":{"fake":{"baseUrl":"http://127.0.0.1:1/v1","api":"openai-completions","models":[{"id":"one"}]}}}');
  writeFileSync(join(pi, "settings.json"), '{"defaultProvider":"pi","defaultModel":"pi"}');
  writeFileSync(join(agent, "settings.json"), '{}');
  const lark = join(home, ".config", "lark-cli");
  mkdirSync(lark, { recursive: true });
  writeFileSync(join(lark, "config.json"), '{"defaultProfile":"finance"}');
  writeFileSync(join(lark, "token.json"), '{"token":"lark-sentinel"}');
  writeFileSync(join(bin, "lark-cli"), '#!/bin/sh\n[ "$1" = doctor ]\n[ "$LARK_PROFILE" = finance ]\n', { mode: 0o755 });
  const invariantPaths = [join(pi, "auth.json"), join(pi, "models.json"), join(pi, "settings.json"), join(lark, "config.json"), join(lark, "token.json")];
  const before = invariantPaths.map((path) => readFileSync(path));
  const oldPath = process.env.PATH; const oldProfile = process.env.LARK_PROFILE; process.env.PATH = `${bin}${delimiter}${oldPath}`; process.env.LARK_PROFILE = "finance"; process.env.MEM0_API_KEY = "not-logged";
  try {
    const result = await checkReadiness(home, agent, "fake/one", { createMemoryClient: () => ({ ping: async () => {} }), thinkingLevel: "medium" });
    assert.equal(result.model, "fake/one");
    assert.equal(result.thinking, "medium");
  } finally { process.env.PATH = oldPath; if (oldProfile === undefined) delete process.env.LARK_PROFILE; else process.env.LARK_PROFILE = oldProfile; }
  assert.deepEqual(invariantPaths.map((path) => readFileSync(path)), before);
  assert.match(readFileSync(join(agent, "settings.json"), "utf8"), /"defaultThinkingLevel": "medium"/);
  assert.doesNotMatch(readFileSync(join(agent, "settings.json"), "utf8"), /not-logged|lark-sentinel/);
});

test("doctor failure is distinct and includes fake doctor diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-doctor-fail-")); const home = join(root, "home"); const pi = join(home, ".pi", "agent"); const agent = join(home, ".feishu-agent"); const bin = join(root, "bin");
  mkdirSync(pi, { recursive: true }); mkdirSync(agent, { recursive: true }); mkdirSync(bin, { recursive: true });
  writeFileSync(join(pi, "auth.json"), '{"fake":{"type":"api_key","key":"safe-fake"}}');
  writeFileSync(join(pi, "models.json"), '{"providers":{"fake":{"baseUrl":"http://127.0.0.1:1/v1","api":"openai-completions","models":[{"id":"one"}]}}}');
  writeFileSync(join(agent, "settings.json"), '{}');
  writeFileSync(join(bin, "lark-cli"), '#!/bin/sh\necho "profile token expired" >&2\nexit 7\n', { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${bin}${delimiter}${oldPath}`; process.env.MEM0_API_KEY = "secret";
  try { await assert.rejects(checkReadiness(home, agent, "fake/one", { createMemoryClient: () => ({ ping: async () => {} }) }), /Lark doctor failed \(exit 7\): profile token expired/); }
  finally { process.env.PATH = oldPath; }
});
