import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MEMORY_APP_ID } from "../../src/memory.js";
import { REMOTE_PACKAGE_SOURCE, REMOTE_PACKAGE_VERSION, feishuRemotePackagePath } from "../../src/remote-package.js";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const cli = join(repoRoot, "dist/src/cli.js");
export const MEM0_PACKAGE = "npm:@mem0/pi-agent-plugin@0.1.5";

export type Failure = "model" | "mem0" | "doctor" | "package" | "skills";

export function run(cwd: string, env: NodeJS.ProcessEnv, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

export function listen(server: Server): Promise<string> {
  return new Promise((done) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    assert(address && typeof address !== "string");
    done(`http://127.0.0.1:${address.port}`);
  }));
}

export function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
}

export function allFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    if (lstatSync(path).isSymbolicLink()) return [];
    return statSync(path).isDirectory() ? allFiles(path) : [path];
  });
}


export async function fixture(failure?: Failure) {
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
mkdir -p "$prefix/node_modules/@mem0" "$prefix/node_modules/@azhi-ss"
ln -sfn ${JSON.stringify(join(repoRoot, "node_modules", "@mem0", "pi-agent-plugin"))} "$prefix/node_modules/@mem0/pi-agent-plugin"
ln -sfn ${JSON.stringify(join(repoRoot, "packages", "feishu-remote"))} "$prefix/node_modules/@azhi-ss/feishu-remote"
printf '{"dependencies":{"@mem0/pi-agent-plugin":"0.1.5","@azhi-ss/feishu-remote":"0.1.0"}}' > "$prefix/package.json"
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

export function configuredPackages(agentHome: string): string[] {
  return JSON.parse(readFileSync(join(agentHome, "settings.json"), "utf8")).packages ?? [];
}

export function assertPinnedRemotePackageInstalled(agentHome: string): void {
  const sources = configuredPackages(agentHome).filter((entry): entry is string => typeof entry === "string" && isRemoteSource(entry));
  assert.deepEqual(sources, [REMOTE_PACKAGE_SOURCE]);
  assert.equal(existsSync(join(agentHome, "npm", "node_modules", "@azhi-ss", "feishu-remote", "package.json")), true);
}

export function isRemoteSource(source: string): boolean {
  return source === "@azhi-ss/feishu-remote" || source.startsWith("npm:@azhi-ss/feishu-remote");
}

export function installs(path: string): string[] {
  return lines(path).filter((line) => line.includes("|install "));
}

export function assertCompleteSummary(output: string, home: string, identity: string, model: string): void {
  assert.match(output, new RegExp(`Feishu Agent Home: ${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(output, new RegExp(`Memory Identity: feishu:${identity}`));
  assert.match(output, new RegExp(`Model: fake/${model}`));
  assert.match(output, /Mem0 Package: ready/);
  assert.match(output, /Remote Package: ready/);
  assert.match(output, /Official Skills: lark-cli 9\.9\.9/);
  assert.match(output, /Lark doctor: passed/);
  assert.match(output, /Memory: available/);
}
