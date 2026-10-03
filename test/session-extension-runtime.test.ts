import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hermeticEnv } from "./helpers/hermetic-env.js";
import { runPty } from "./helpers/pty-harness.js";

const cli = join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "dist/src/cli.js");

// A prompt after /new must still be able to call the captured extension API.
// Session replacement disposes the previous runner, which marks the shared
// extension runtime stale; the next session has to load a fresh one.
test("a prompt after /new can call extension tool APIs", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-session-ext-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const bin = join(root, "bin");
  const extension = join(root, "tool-probe");
  const trace = join(root, "tools.log");
  for (const path of [join(home, ".pi", "agent"), join(home, ".feishu-agent"), project, bin, extension]) mkdirSync(path, { recursive: true });

  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (request.url?.endsWith("/chat/completions")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('data: {"choices":[{"delta":{"content":"PTY-PONG"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      } else response.writeHead(404).end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");

  writeFileSync(join(home, ".pi", "agent", "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "fake-key" } }));
  writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", models: [
    { id: "fake-model", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 256 },
  ] } } }));
  writeFileSync(join(extension, "package.json"), JSON.stringify({ name: "tool-probe", version: "1.0.0", pi: { extensions: ["index.js"] } }));
  writeFileSync(join(extension, "index.js"), `import { appendFileSync } from "node:fs";
export default (pi) => {
  pi.on("before_agent_start", () => {
    try {
      pi.getAllTools();
      appendFileSync(process.env.FEISHU_TOOL_TRACE, "ok\\n");
    } catch (error) {
      appendFileSync(process.env.FEISHU_TOOL_TRACE, "ERR|" + (error instanceof Error ? error.message : String(error)) + "\\n");
    }
  });
};
`);
  writeFileSync(join(home, ".feishu-agent", "settings.json"), JSON.stringify({
    defaultProvider: "fake", defaultModel: "fake-model", quietStartup: true, collapseChangelog: true, packages: [extension],
  }));
  writeFileSync(join(home, ".feishu-agent", "SYSTEM.md"), "You are Feishu Agent.\n");
  writeFileSync(join(bin, "lark-cli"), "#!/bin/sh\n[ \"$1\" = --version ] && { echo \"lark-cli 1.0.0\"; exit; }\n[ \"$*\" = \"skills list --json\" ] && { echo \"[]\"; exit; }\nexit 0\n", { mode: 0o755 });

  const env = hermeticEnv({
    HOME: home,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    TERM: "xterm-256color",
    COLUMNS: "110",
    LINES: "32",
    PI_OFFLINE: "1",
    FEISHU_TOOL_TRACE: trace,
  });

  try {
    const result = await runPty(project, [], env, [
      { wait: "fake-model", send: "one\r" },
      { wait: "PTY-PONG", send: "/new\r" },
      { wait: "New session started", send: "two\r" },
      { wait: "PTY-PONG", send: "/quit\r" },
    ], { cliPath: cli });
    assert.equal(result.code, 0, result.output);
    assert.doesNotMatch(result.output, /stale after session/);
    const lines = readFileSync(trace, "utf8").trim().split("\n");
    assert.deepEqual(lines, ["ok", "ok"], `${lines.join("\n")}\n${result.output}`);
  } finally {
    server.close();
  }
});
