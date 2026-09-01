import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "dist/src/cli.js");
const MEM0_PACKAGE = "npm:@mem0/pi-agent-plugin@0.1.5";

function run(cwd: string, env: NodeJS.ProcessEnv, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

function listen(server: Server): Promise<string> {
  return new Promise((done) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    assert(address && typeof address !== "string");
    done(`http://127.0.0.1:${address.port}`);
  }));
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
}

function allFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    if (lstatSync(path).isSymbolicLink()) return [];
    return statSync(path).isDirectory() ? allFiles(path) : [path];
  });
}

type Failure = "model" | "mem0" | "doctor" | "package" | "skills";

async function fixture(failure?: Failure) {
  const root = mkdtempSync(join(tmpdir(), "feishu-init-e2e-"));
  const home = join(root, "home"), project = join(root, "project"), bin = join(root, "bin"), control = join(root, "control");
  const pi = join(home, ".pi", "agent"), agentHome = join(home, ".feishu-agent");
  mkdirSync(pi, { recursive: true }); mkdirSync(project, { recursive: true }); mkdirSync(bin, { recursive: true }); mkdirSync(control, { recursive: true });
  const secret = "MEM0-SENTINEL-KEY";
  writeFileSync(join(pi, "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "fake-model-key" } }));
  const writeModels = (available = true) => writeFileSync(join(pi, "models.json"), JSON.stringify({ providers: { fake: {
    baseUrl: modelHost, api: "openai-completions", models: available ? ["fake-model", "other-model"].map((id) => ({ id, reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 256 })) : [],
  } } }));

  const modelRequests: any[] = [];
  const modelServer = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => body += chunk);
    request.on("end", () => {
      if (request.url?.endsWith("/chat/completions")) {
        modelRequests.push(JSON.parse(body));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('data: {"choices":[{"delta":{"content":"pong"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      } else response.writeHead(404).end();
    });
  });
  const modelHost = `${await listen(modelServer)}/v1`;
  writeModels(failure !== "model");

  let failMem0 = failure === "mem0";
  const memoryRequests: Array<{ method?: string; url?: string; body: string }> = [];
  const mem0Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => body += chunk);
    request.on("end", () => {
      memoryRequests.push({ method: request.method, url: request.url, body });
      response.writeHead(failMem0 ? 503 : 200, { "content-type": "application/json" });
      response.end(failMem0 ? '{"message":"temporarily unavailable"}' : request.url === "/v1/ping/" ? '{"status":"ok"}' : '{"results":[]}');
      failMem0 = false;
    });
  });
  const mem0Host = await listen(mem0Server);

  const larkLog = join(control, "lark.log"), npmLog = join(control, "npm.log");
  if (failure === "doctor") writeFileSync(join(control, "fail-doctor"), "1");
  if (failure === "skills") writeFileSync(join(control, "fail-skills"), "1");
  if (failure === "package") writeFileSync(join(control, "fail-package"), "1");
  writeFileSync(join(bin, "lark-cli"), `#!/bin/sh
set -eu
printf '%s|%s\n' "\${MEM0_TELEMETRY:-}" "$*" >> ${JSON.stringify(larkLog)}
case "$*" in
  "doctor") if [ -f ${JSON.stringify(join(control, "fail-doctor"))} ]; then rm ${JSON.stringify(join(control, "fail-doctor"))}; echo "doctor injected failure" >&2; exit 7; fi; echo "doctor ok";;
  "--version") if [ -f ${JSON.stringify(join(control, "lark-version"))} ]; then cat ${JSON.stringify(join(control, "lark-version"))}; else echo "lark-cli 9.9.9"; fi;;
  "skills list --json") if [ -f ${JSON.stringify(join(control, "fail-skills"))} ]; then rm ${JSON.stringify(join(control, "fail-skills"))}; echo "skill injected failure" >&2; exit 8; fi; echo '["docs"]';;
  "skills read docs") printf -- '---\nname: docs\ndescription: OFFICIAL_SKILL_SENTINEL\n---\nUse the official docs workflow.\n';;
  *) exit 2;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, "npm"), `#!/bin/sh
set -eu
printf '%s|%s\n' "\${MEM0_TELEMETRY:-}" "$*" >> ${JSON.stringify(npmLog)}
if [ "$*" = "root -g" ]; then echo ${JSON.stringify(join(root, "global-node-modules"))}; exit 0; fi
if [ -f ${JSON.stringify(join(control, "fail-package"))} ]; then rm ${JSON.stringify(join(control, "fail-package"))}; echo "package injected failure" >&2; exit 9; fi
prefix=""
while [ "$#" -gt 0 ]; do [ "$1" = --prefix ] && { prefix="$2"; break; }; shift; done
[ -n "$prefix" ]
mkdir -p "$prefix/node_modules/@mem0"
ln -s ${JSON.stringify(join(repoRoot, "node_modules", "@mem0", "pi-agent-plugin"))} "$prefix/node_modules/@mem0/pi-agent-plugin"
printf '{"dependencies":{"@mem0/pi-agent-plugin":"0.1.5"}}' > "$prefix/package.json"
`, { mode: 0o755 });

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}`, MEM0_API_KEY: secret, MEM0_API_HOST: mem0Host, PI_OFFLINE: "1" };
  return {
    root, home, project, pi, agentHome, secret, env, modelRequests, memoryRequests, larkLog, npmLog,
    writeModels,
    setLarkVersion(version: string) { writeFileSync(join(control, "lark-version"), version); },
    failSkills() { writeFileSync(join(control, "fail-skills"), "1"); },
    close() { modelServer.close(); mem0Server.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

function configuredPackages(agentHome: string): string[] {
  return JSON.parse(readFileSync(join(agentHome, "settings.json"), "utf8")).packages ?? [];
}

function installs(path: string): string[] {
  return lines(path).filter((line) => line.includes("|install "));
}

function assertCompleteSummary(output: string, home: string, identity: string, model: string): void {
  assert.match(output, new RegExp(`Feishu Agent Home: ${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(output, new RegExp(`Memory Identity: feishu:${identity}`));
  assert.match(output, new RegExp(`Model: fake/${model}`));
  assert.match(output, /Mem0 Package: ready/);
  assert.match(output, /Official Skills: lark-cli 9\.9\.9/);
  assert.match(output, /Lark doctor: passed/);
  assert.match(output, /Memory: available/);
}

test("fresh HOME one-command init is immediately Print-ready, idempotent, isolated, reset-explicit, and secret-free", async () => {
  const f = await fixture();
  try {
    assert.equal(existsSync(f.agentHome), false);
    const first = await run(f.project, f.env, ["init", "--identity", "alice", "--model", "fake/fake-model", "--thinking", "medium"]);
    assert.equal(first.code, 0, first.stderr);
    assertCompleteSummary(first.stdout, f.agentHome, "alice", "fake-model");
    assert.doesNotMatch(first.stdout + first.stderr, new RegExp(f.secret));
    assert.equal(configuredPackages(f.agentHome).filter((entry) => entry === MEM0_PACKAGE).length, 1);
    assert(lines(f.npmLog).every((line) => line.startsWith("false|")));
    assert(lines(f.larkLog).every((line) => line.startsWith("false|")));

    const printed = await run(f.project, f.env, ["-p", "ping"]);
    assert.equal(printed.code, 0, printed.stderr);
    assert.match(printed.stdout, /pong/);
    const modelRequest = f.modelRequests.at(-1);
    assert.equal(modelRequest.model, "fake-model");
    assert.match(JSON.stringify(modelRequest), /OFFICIAL_SKILL_SENTINEL/);
    const memorySearch = f.memoryRequests.find((request) => request.url === "/v3/memories/search/");
    assert(memorySearch, "Print must perform Mem0 recall");
    assert.match(memorySearch.body, /"user_id":"feishu:alice"/);
    assert.match(memorySearch.body, /"app_id":"project-/);

    const bareRerun = await run(f.project, f.env, ["init"]);
    assert.equal(bareRerun.code, 0, bareRerun.stderr);
    assertCompleteSummary(bareRerun.stdout, f.agentHome, "alice", "fake-model");

    const customSystem = "You are Feishu Agent. CUSTOM FEISHU IDENTITY\n";
    writeFileSync(join(f.agentHome, "SYSTEM.md"), customSystem);
    writeFileSync(join(f.agentHome, "custom.txt"), "keep me\n");
    const rerun = await run(f.project, f.env, ["init", "--identity", "bob", "--model", "fake/other-model", "--thinking", "high"]);
    assert.equal(rerun.code, 0, rerun.stderr);
    assertCompleteSummary(rerun.stdout, f.agentHome, "alice", "fake-model");
    const settings = JSON.parse(readFileSync(join(f.agentHome, "settings.json"), "utf8"));
    assert.deepEqual([settings.defaultProvider, settings.defaultModel, settings.defaultThinkingLevel], ["fake", "fake-model", "medium"]);
    assert.equal(readFileSync(join(f.agentHome, "SYSTEM.md"), "utf8"), customSystem);
    assert.match(readFileSync(join(f.agentHome, "mem0-config.json"), "utf8"), /feishu:alice/);
    assert.equal(readFileSync(join(f.agentHome, "custom.txt"), "utf8"), "keep me\n");
    assert.equal(lines(f.npmLog).length, 1, "valid package must not be installed twice");
    assert.equal(lines(f.larkLog).filter((line) => line.endsWith("|skills list --json")).length, 1, "valid Skill cache must be reused");

    const reset = await run(f.project, f.env, ["init", "--identity", "bob", "--model", "fake/other-model", "--thinking", "high", "--reset-identity", "--reset-model", "--reset-system"]);
    assert.equal(reset.code, 0, reset.stderr);
    assertCompleteSummary(reset.stdout, f.agentHome, "bob", "other-model");
    assert.notEqual(readFileSync(join(f.agentHome, "SYSTEM.md"), "utf8"), customSystem);
    assert.match(readFileSync(join(f.agentHome, "mem0-config.json"), "utf8"), /feishu:bob/);
    assert.equal(readFileSync(join(f.agentHome, "custom.txt"), "utf8"), "keep me\n");
    assert.equal(existsSync(join(f.project, ".pi")), false);
    for (const path of allFiles(f.agentHome)) assert.doesNotMatch(readFileSync(path).toString(), new RegExp(f.secret), path);
    assert.doesNotMatch(first.stdout + first.stderr + printed.stdout + printed.stderr + rerun.stdout + rerun.stderr + reset.stdout + reset.stderr, new RegExp(f.secret));
  } finally { f.close(); }
});

test("official Skill sync failure continues with a successful prior cache warning", async () => {
  const f = await fixture();
  try {
    f.setLarkVersion("lark-cli 9.9.8");
    const cached = await run(f.project, f.env, ["init", "--identity", "alice", "--model", "fake/fake-model"]);
    assert.equal(cached.code, 0, cached.stderr);

    f.setLarkVersion("lark-cli 9.9.9");
    f.failSkills();
    const fallback = await run(f.project, f.env, ["init", "--identity", "alice", "--model", "fake/fake-model"]);
    assert.equal(fallback.code, 0, fallback.stderr);
    assertCompleteSummary(fallback.stdout, f.agentHome, "alice", "fake-model");
    assert.match(fallback.stderr, /Startup Warning: Official Skills for lark-cli 9\.9\.9 unavailable; using lark-cli 9\.9\.8\./);
    assert.equal(lines(f.larkLog).filter((line) => line.endsWith("|skills list --json")).length, 2);
  } finally { f.close(); }
});

test("init installs the exact Mem0 package for similar or stale settings", async () => {
  const f = await fixture();
  try {
    mkdirSync(f.agentHome, { recursive: true });
    writeFileSync(join(f.agentHome, "settings.json"), JSON.stringify({ packages: ["npm:@mem0/pi-agent-plugin@0.1.4", "npm:@mem0/pi-agent-plugin-extra"] }));
    const similar = await run(f.project, f.env, ["init", "--identity", "alice", "--model", "fake/fake-model"]);
    assert.equal(similar.code, 0, similar.stderr);
    assert.equal(installs(f.npmLog).length, 1);
    assert.equal(configuredPackages(f.agentHome).filter((entry) => entry === MEM0_PACKAGE).length, 1);

    rmSync(join(f.agentHome, "npm", "node_modules", "@mem0", "pi-agent-plugin"), { recursive: true, force: true });
    const stale = await run(f.project, f.env, ["init", "--identity", "alice", "--model", "fake/fake-model"]);
    assert.equal(stale.code, 0, stale.stderr);
    assert.equal(installs(f.npmLog).length, 2, "missing exact package files must be reinstalled");
    assert.equal(configuredPackages(f.agentHome).filter((entry) => entry === MEM0_PACKAGE).length, 1);
  } finally { f.close(); }
});

for (const failure of ["model", "mem0", "doctor", "package", "skills"] as const) {
  test(`init rerun after injected ${failure} failure completes only missing persistent work`, async () => {
    const f = await fixture(failure);
    try {
      const first = await run(f.project, f.env, ["init", "--identity", "alice", "--model", "fake/fake-model", "--thinking", "medium"]);
      assert.notEqual(first.code, 0, `${failure} failure was not injected`);
      assert.doesNotMatch(first.stdout + first.stderr, new RegExp(f.secret));
      if (failure === "model") f.writeModels(true);
      const systemBefore = readFileSync(join(f.agentHome, "SYSTEM.md"));
      const identityBefore = readFileSync(join(f.agentHome, "mem0-config.json"));
      const installsBefore = lines(f.npmLog).length;
      const syncsBefore = lines(f.larkLog).filter((line) => line.endsWith("|skills list --json")).length;

      const requestedModel = failure === "model" ? "fake/other-model" : "fake/fake-model";
      const second = await run(f.project, f.env, ["init", "--identity", "bob", "--model", requestedModel, "--thinking", "high"]);
      assert.equal(second.code, 0, second.stderr);
      assertCompleteSummary(second.stdout, f.agentHome, "alice", requestedModel.slice(5));
      assert.deepEqual(readFileSync(join(f.agentHome, "SYSTEM.md")), systemBefore);
      assert.deepEqual(readFileSync(join(f.agentHome, "mem0-config.json")), identityBefore);
      assert.equal(configuredPackages(f.agentHome).filter((entry) => entry === MEM0_PACKAGE).length, 1);
      assert.equal(existsSync(join(f.project, ".pi")), false);
      assert.doesNotMatch(second.stdout + second.stderr, new RegExp(f.secret));

      const installsAfter = lines(f.npmLog).length;
      const syncsAfter = lines(f.larkLog).filter((line) => line.endsWith("|skills list --json")).length;
      if (failure === "skills") {
        assert.equal(installsBefore, 1, "completed package install must survive Skill failure");
        assert.equal(installsAfter, 1, "Skill rerun must not reinstall package");
        assert.equal(syncsBefore, 1); assert.equal(syncsAfter, 2);
      } else if (failure === "package") {
        assert.equal(installsBefore, 1); assert.equal(installsAfter, 2, "failed package install is the missing work");
        assert.equal(syncsBefore, 0); assert.equal(syncsAfter, 1);
      } else {
        assert.equal(installsBefore, 0); assert.equal(installsAfter, 1);
        assert.equal(syncsBefore, 0); assert.equal(syncsAfter, 1);
      }
    } finally { f.close(); }
  });
}
