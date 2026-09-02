import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "dist/src/cli.js");

function listen(server: Server): Promise<string> {
  return new Promise((done) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    assert(address && typeof address !== "string");
    done(`http://127.0.0.1:${address.port}`);
  }));
}

test("print from HOME (project root aliases Agent Home) never invokes npm or creates .pi/npm", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-home-project-"));
  const home = join(root, "home");
  const pi = join(home, ".pi", "agent");
  const agent = join(home, ".feishu-agent");
  const bin = join(root, "bin");
  const npmMarker = join(root, "npm-called");
  mkdirSync(pi, { recursive: true });
  mkdirSync(join(agent, "npm", "node_modules", "@mem0"), { recursive: true });
  mkdirSync(bin, { recursive: true });

  const server = createServer((request, response) => {
    if (request.url?.endsWith("/chat/completions")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"HOME-OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    } else { response.writeHead(404).end(); }
  });
  const modelHost = await listen(server);

  writeFileSync(join(pi, "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "fake-key" } }));
  writeFileSync(join(pi, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `${modelHost}/v1`, api: "openai-completions", models: [{ id: "one", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 256 }] } } }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "one", quietStartup: true, collapseChangelog: true, packages: ["npm:@mem0/pi-agent-plugin@0.1.5"] }));
  symlinkSync(join(repoRoot, "node_modules", "@mem0", "pi-agent-plugin"), join(agent, "npm", "node_modules", "@mem0", "pi-agent-plugin"));
  writeFileSync(join(bin, "lark-cli"), '#!/bin/sh\ncase "$*" in "--version") echo "lark-cli test";; "skills list --json") echo "[]";; "doctor") exit 0;; *) exit 2;; esac\n', { mode: 0o755 });
  writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "npm-called: $*" >> "${npmMarker}"\nexit 1\n`, { mode: 0o755 });

  const env = { ...process.env, HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}`, NPM_MARKER: npmMarker };
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [cli, "-p", "ping"], { cwd: home, env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
  try {
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /HOME-OK/);
    assert.equal(existsSync(npmMarker), false, `npm was invoked: ${existsSync(npmMarker) ? readFileSync(npmMarker, "utf8") : ""}`);
    assert.equal(statSync(join(home, ".pi", "npm"), { throwIfNoEntry: false }), undefined, "HOME/.pi/npm must not be created");
  } finally { server.close(); }
});
