import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { baseEnv, coreCli, createCliHarness, files, fixture, repoRoot, textResponse, toolResponse, type CliResult, type Fixture } from "./helpers/automation-cli-fixture.js";

const { modelServers } = createCliHarness();
const feishuSend = join(repoRoot, "skills", "feishu-control", "feishu-send");

function run(f: Fixture, command: string, args: string[]): Promise<CliResult> {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: f.root, env: baseEnv(f, { FEISHU_CONTROL_CWD: f.root }) });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

const feishu = (f: Fixture, args: string[]) => run(f, process.execPath, [coreCli, ...args]);
const send = (f: Fixture, args: string[]) => run(f, "bash", [feishuSend, ...args]);

function sessionId(result: CliResult): string {
  const id = /^Feishu Session: (\S+)$/m.exec(result.stderr)?.[1];
  assert(id, result.stderr);
  return id;
}

function sessionFiles(f: Fixture): string[] {
  const root = join(f.home, ".feishu-agent", "sessions");
  return existsSync(root) ? files(root).filter((path) => path.endsWith(".jsonl")) : [];
}

async function printFixture(): Promise<Fixture> {
  const f = await fixture();
  modelServers.push(f.model.server);
  return f;
}

test("Print reports its session, and --session <id> -p continues it with the earlier context", async () => {
  const f = await printFixture();
  f.model.responses.push(textResponse("DRAFT-V1"), textResponse("DRAFT-V2"));

  const first = await feishu(f, ["-p", "draft the weekly note"]);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /DRAFT-V1/);
  const id = sessionId(first);

  const second = await feishu(f, ["--session", id, "-p", "make it shorter"]);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /DRAFT-V2/);
  assert.equal(sessionId(second), id);
  assert.equal(f.model.requests.length, 2);
  for (const earlier of ["draft the weekly note", "DRAFT-V1", "make it shorter"]) assert.match(f.model.requests[1], new RegExp(earlier));
  assert.equal(sessionFiles(f).length, 1);
});

test("ask_user ends the delegated turn with exit 3, and feishu-send --session delivers the answer", async () => {
  const f = await printFixture();
  const question = { question: "Tuesday afternoon or Thursday morning?", options: ["Tuesday afternoon", "Thursday morning"] };
  f.model.responses.push(toolResponse("ask_user", question, "ask-1"), textResponse("SCHEDULED-THURSDAY"));

  const asked = await send(f, ["schedule a sync with Zhang next week"]);
  assert.equal(asked.code, 3, asked.stderr);
  assert.equal(asked.stdout, "Tuesday afternoon or Thursday morning?\n1. Tuesday afternoon\n2. Thursday morning\n");
  assert.equal(f.model.requests.length, 1, "the run must stop at the question");
  const tools = JSON.parse(f.model.requests[0]).tools.map((tool: { function: { name: string } }) => tool.function.name);
  assert(tools.includes("ask_user"), tools.join(","));

  const answered = await send(f, ["--session", sessionId(asked), "Thursday morning"]);
  assert.equal(answered.code, 0, answered.stderr);
  assert.match(answered.stdout, /SCHEDULED-THURSDAY/);
  assert.equal(sessionId(answered), sessionId(asked));
  assert.match(f.model.requests[1], /Tuesday afternoon or Thursday morning\?/);
  assert.equal(sessionFiles(f).length, 1);
});

function batchResponse(calls: Array<{ name: string; input: unknown; id: string }>): string {
  const toolCalls = calls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }));
  return `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
}

test("ask_user alongside another tool does not run that tool and still exits 3", async () => {
  const f = await printFixture();
  const marker = join(f.root, "should-not-exist");
  f.model.responses.push(batchResponse([
    { name: "bash", input: { command: `touch ${JSON.stringify(marker).slice(1, -1)}` }, id: "bash-1" },
    { name: "ask_user", input: { question: "Send this note?", options: ["Send", "Hold"] }, id: "ask-1" },
  ]));

  const result = await feishu(f, ["-p", "draft a note and check before sending"]);
  assert.equal(result.code, 3, result.stderr);
  assert.equal(result.stdout, "Send this note?\n1. Send\n2. Hold\n");
  assert.equal(existsSync(marker), false);
  assert.equal(f.model.requests.length, 1);
});

test("an unknown --session fails before any model request and creates no session", async () => {
  const f = await printFixture();
  const result = await feishu(f, ["--session", "missing-id", "-p", "hello"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /No Feishu session found matching 'missing-id'/);
  assert.equal(f.model.requests.length, 0);
  assert.deepEqual(sessionFiles(f), []);
});
