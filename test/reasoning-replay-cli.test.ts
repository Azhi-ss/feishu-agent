import assert from "node:assert/strict";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { projectKeyFor } from "../src/policy.js";
import { hermeticEnv } from "./helpers/hermetic-env.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "dist/src/cli.js");

// Markers used across scenarios. Only the *final-answer* reasoning markers are
// allowed to disappear from later requests; answer text and tool evidence stay.
const FINAL_REASONING = "REPLAY-MARKER-final-reasoning";
const ANSWER_TEXT = "REPLAY-MARKER-final-answer";
const TOOL_REASONING = "REPLAY-MARKER-tool-step-reasoning";
const TOOL_ANSWER = "REPLAY-MARKER-tool-answer";
const SIGNED_REASONING = "REPLAY-MARKER-signed-reasoning";
const SIGNED_ANSWER = "REPLAY-MARKER-signed-answer";
const REDACTED_REASONING = "REPLAY-MARKER-redacted-reasoning";
const ABORTED_REASONING = "REPLAY-MARKER-aborted-reasoning";
const LENGTH_REASONING = "REPLAY-MARKER-length-reasoning";
const LENGTH_ANSWER = "REPLAY-MARKER-length-answer";
const THINK_ONLY_REASONING = "REPLAY-MARKER-thinkonly-reasoning";

interface WireRequest {
  url: string;
  messages: any[];
  raw: string;
}

interface Harness {
  home: string;
  cwd: string;
  sessionDir: string;
  requests: WireRequest[];
  close: () => Promise<void>;
  port: number;
}

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function startHarness(handler: (req: IncomingMessage, res: ServerResponse, body: string, requests: WireRequest[]) => void): Promise<Harness> {
  const requests: WireRequest[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => body += chunk);
    request.on("end", () => {
      let parsed: { messages?: any[] } = {};
      try { parsed = JSON.parse(body); } catch { /* loopback server keeps serving even malformed bodies */ }
      requests.push({ url: request.url ?? "", messages: parsed.messages ?? [], raw: body });
      handler(request, response, body, requests);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;

  const root = mkdtempSync(join(tmpdir(), "feishu-replay-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const pi = join(home, ".pi", "agent");
  const feishu = join(home, ".feishu-agent");
  const bin = join(root, "bin");
  mkdirSync(join(feishu, "skills"), { recursive: true });
  mkdirSync(pi, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(pi, "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "fake-key" } }));
  const models = [{ id: "fake-model", name: "Fake", reasoning: true, input: ["text"], contextWindow: 100000, maxTokens: 1024, compat: { requiresThinkingAsText: true } },
    { id: "second-model", name: "Second", reasoning: true, input: ["text"], contextWindow: 100000, maxTokens: 1024, compat: { requiresThinkingAsText: true } }];
  writeFileSync(join(pi, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", models } } }));
  writeFileSync(join(feishu, "SYSTEM.md"), "You are Feishu Agent.\n");
  writeFileSync(join(bin, "lark-cli"), "#!/bin/sh\n[ \"$1\" = --version ] && { echo \"lark-cli 1.0.0\"; exit 0; }\nexit 0\n", { mode: 0o755 });
  const sessionDir = join(feishu, "sessions", projectKeyFor(cwd));
  return {
    home, cwd, sessionDir, requests, port,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

function feishuSettings(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { defaultProvider: "fake", defaultModel: "fake-model", quietStartup: true, collapseChangelog: true, ...extra };
}

function envFor(h: Harness, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const bin = join(h.home, "..", "bin");
  return hermeticEnv({ HOME: h.home, PATH: `${bin}${delimiter}${process.env.PATH}`, PI_OFFLINE: "1", TERM: "xterm-256color", COLUMNS: "120", LINES: "32", ...extra });
}

/** SSE response: stream reasoning then text, finish with stop. */
function sseAnswer(text: string, reasoning?: string): string {
  const deltas = [];
  if (reasoning) deltas.push({ reasoning_content: reasoning });
  deltas.push({ content: text });
  return deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`).join("")
    + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
}

function defaultHandler(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(sseAnswer("FOLLOWUP-ANSWER"));
}

interface PtyAction { wait: string; send: string; }

function runPty(cwd: string, args: string[], env: NodeJS.ProcessEnv, actions: PtyAction[], timeoutSec = 60, killAfterLastActionSec?: number): Promise<{ code: number | null; output: string }> {
  const python = `import json,os,pty,select,sys,time
actions=json.loads(sys.argv[5]); timeout=float(sys.argv[6]); kill_after=float(sys.argv[7]) if len(sys.argv)>7 and sys.argv[7] else 0; pid,fd=pty.fork()
if pid==0:
 os.chdir(sys.argv[1]); os.execvpe(sys.argv[2],[sys.argv[2],sys.argv[3],*json.loads(sys.argv[4])],os.environ)
out=b''; checkpoint=0; action=0; end=time.time()+timeout; done_at=None
while time.time()<end:
 r,_,_=select.select([fd],[],[],0.1)
 if r:
  try: out+=os.read(fd,65536)
  except OSError:
   _,status=os.waitpid(pid,0); print(out.decode('utf-8','replace')); sys.exit(os.waitstatus_to_exitcode(status))
 if action<len(actions) and actions[action]['wait'].encode() in out[checkpoint:]:
  time.sleep(.2); os.write(fd,actions[action]['send'].encode()); action+=1
  if action==len(actions) and kill_after>0: done_at=time.time()+kill_after
 if action<len(actions): checkpoint=len(out)
 if done_at and time.time()>done_at:
  os.kill(pid,15); print(out.decode('utf-8','replace')); sys.exit(0)
 p,status=os.waitpid(pid,os.WNOHANG)
 if p:
  print(out.decode('utf-8','replace')); sys.exit(os.waitstatus_to_exitcode(status) if action==len(actions) else 125)
os.kill(pid,15); print(out.decode('utf-8','replace')); sys.exit(124)`;
  return new Promise((done) => {
    const child: ChildProcess = spawn("python3", ["-c", python, cwd, process.execPath, cli, JSON.stringify(args), JSON.stringify(actions), String(timeoutSec), String(killAfterLastActionSec ?? 0)], { env });
    if (!child.stdout || !child.stderr) throw new Error("pty subprocess has no stdio");
    let output = "";
    child.stdout.on("data", (chunk) => output += chunk);
    child.stderr.on("data", (chunk) => output += chunk);
    child.on("close", (code) => done({ code, output }));
  });
}

/** Seed a prior session containing every lifecycle/protocol fixture. */
function seedHistory(h: Harness, settings: Record<string, unknown>): string {
  writeFileSync(join(h.home, ".feishu-agent", "settings.json"), JSON.stringify(settings));
  const manager = SessionManager.create(h.cwd, h.sessionDir);
  const now = Date.now();
  const assistant = (content: unknown[], stopReason: string, ts = now) =>
    ({ role: "assistant", api: "openai-completions", provider: "fake", model: "fake-model", timestamp: ts, stopReason, usage: zeroUsage, content });
  manager.appendMessage({ role: "user", content: "final answer question", timestamp: now } as never);
  manager.appendMessage(assistant([{ type: "thinking", thinking: FINAL_REASONING }, { type: "text", text: ANSWER_TEXT }], "stop") as never);
  manager.appendMessage({ role: "user", content: "tool step question", timestamp: now + 1 } as never);
  manager.appendMessage(assistant([{ type: "thinking", thinking: TOOL_REASONING }, { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo evidence" } }], "toolUse", now + 2) as never);
  manager.appendMessage({ role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "TOOL-RESULT-EVIDENCE" }], isError: false, timestamp: now + 3 } as never);
  manager.appendMessage(assistant([{ type: "text", text: TOOL_ANSWER }], "stop", now + 4) as never);
  manager.appendMessage({ role: "user", content: "signed reasoning question", timestamp: now + 5 } as never);
  manager.appendMessage(assistant([{ type: "thinking", thinking: SIGNED_REASONING, thinkingSignature: "sig-chain" }, { type: "text", text: SIGNED_ANSWER }], "stop", now + 6) as never);
  manager.appendMessage({ role: "user", content: "aborted question", timestamp: now + 7 } as never);
  manager.appendMessage(assistant([{ type: "thinking", thinking: ABORTED_REASONING }], "aborted", now + 8) as never);
  manager.appendMessage({ role: "user", content: "truncated question", timestamp: now + 9 } as never);
  manager.appendMessage(assistant([{ type: "thinking", thinking: LENGTH_REASONING }, { type: "text", text: LENGTH_ANSWER }], "length", now + 10) as never);
  manager.appendMessage({ role: "user", content: "thinking only question", timestamp: now + 11 } as never);
  manager.appendMessage(assistant([{ type: "thinking", thinking: THINK_ONLY_REASONING }], "stop", now + 12) as never);
  manager.appendMessage({ role: "user", content: "redacted question", timestamp: now + 13 } as never);
  manager.appendMessage(assistant([{ type: "thinking", thinking: REDACTED_REASONING, redacted: true, thinkingSignature: "opaque-state" }, { type: "text", text: "redacted-answer" }], "stop", now + 14) as never);
  return manager.getSessionFile()!;
}

test("multi-turn fresh session: model-generated final reasoning is trimmed in next request, answer and disk record preserved", async () => {
  let turn = 0;
  const h = await startHarness((_req, res) => {
    turn += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sseAnswer(`ANSWER-TURN-${turn}`, `SECRET-THOUGHT-${turn}`));
  });
  writeFileSync(join(h.home, ".feishu-agent", "settings.json"), JSON.stringify(feishuSettings()));

  try {
    const result = await runPty(h.cwd, [], envFor(h), [
      { wait: "fake-model", send: "hello first turn\r" },
      { wait: "ANSWER-TURN-1", send: "hello second turn\r" },
      { wait: "ANSWER-TURN-2", send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);

    assert.equal(h.requests.length, 2, "two turns executed");
    const secondReq = h.requests[1];
    const wire = JSON.stringify(secondReq.messages);

    // Assert the model-generated reasoning from turn 1 is NOT sent in turn 2
    assert.doesNotMatch(wire, /SECRET-THOUGHT-1/, "turn 1 reasoning trimmed from turn 2 request");
    assert.match(wire, /ANSWER-TURN-1/, "turn 1 answer text preserved on the wire");

    // Assert that the on-disk session record still contains turn 1 reasoning
    const sessionFiles = (await import("node:fs")).readdirSync(h.sessionDir).filter((f) => f.endsWith(".jsonl"));
    assert.equal(sessionFiles.length, 1);
    const sessionContent = readFileSync(join(h.sessionDir, sessionFiles[0]), "utf8");
    assert.match(sessionContent, /SECRET-THOUGHT-1/, "turn 1 reasoning preserved in on-disk session");
    assert.match(sessionContent, /ANSWER-TURN-1/, "turn 1 answer preserved in on-disk session");
  } finally {
    await h.close();
  }
});

test("normal request: completed final-answer reasoning is trimmed on the very next request, answers/tools/records stay", async () => {
  const h = await startHarness(defaultHandler);
  const sessionFile = seedHistory(h, feishuSettings());
  try {
    const result = await runPty(h.cwd, ["-c"], envFor(h), [
      { wait: ANSWER_TEXT, send: "follow up now\r" },
      { wait: "FOLLOWUP-ANSWER", send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);

    // The resuming normal request after "follow up now" must omit the trim candidate.
    const followup = h.requests.find((request) => JSON.stringify(request.messages).includes("follow up now"))!;
    assert(followup, "expected a normal request carrying the follow-up prompt");
    const wire = JSON.stringify(followup.messages);
    assert.doesNotMatch(wire, new RegExp(FINAL_REASONING), "trimmed final-answer reasoning absent from wire");
    for (const preserved of [ANSWER_TEXT, TOOL_REASONING, "echo evidence", "TOOL-RESULT-EVIDENCE", TOOL_ANSWER, SIGNED_REASONING, SIGNED_ANSWER, LENGTH_REASONING, LENGTH_ANSWER, REDACTED_REASONING]) {
      assert.match(wire, new RegExp(preserved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `preserved: ${preserved}`);
    }
    // Aborted/think-only assistant messages carry no answer text, so the provider
    // never serializes them in history at all; verify they stay in the raw record.
    for (const recordMarker of [ABORTED_REASONING, THINK_ONLY_REASONING]) {
      assert.match(readFileSync(sessionFile, "utf8"), new RegExp(recordMarker), `recorded: ${recordMarker}`);
    }
    // Tool call identity/order and its reasoning survive together.
    const assistantWithTool = followup.messages.find((message: any) => message.role === "assistant" && JSON.stringify(message).includes("echo evidence"));
    assert(assistantWithTool, "tool-step assistant message retained");
    assert.deepEqual(assistantWithTool.tool_calls[0].id, "call-1");
    assert.match(JSON.stringify(assistantWithTool), new RegExp(TOOL_REASONING), "tool-step reasoning retained");

    // Positive evidence this is not all-pass-through: the final-answer wire message
    // keeps only the answer text and carries no reasoning.
    const trimmedWireMessage = followup.messages.find((message: any) => message.role === "assistant" && (message.content === ANSWER_TEXT || JSON.stringify(message.content) === JSON.stringify([{ type: "text", text: ANSWER_TEXT }])));
    assert(trimmedWireMessage, "final answer present as an assistant wire message");
    assert(!JSON.stringify(trimmedWireMessage).includes(FINAL_REASONING));

    // On-disk original record still contains the reasoning (not rewritten).
    const onDisk = readFileSync(sessionFile, "utf8");
    assert.match(onDisk, new RegExp(FINAL_REASONING));
    assert.match(onDisk, new RegExp(TOOL_REASONING));
  } finally {
    await h.close();
  }
});

test("model switch keeps the same unified semantic rule (no model-name gate)", async () => {
  const h = await startHarness(defaultHandler);
  const sessionFile = seedHistory(h, feishuSettings());
  try {
    const result = await runPty(h.cwd, ["-c"], envFor(h), [
      { wait: ANSWER_TEXT, send: "/model fake/second-model\r" },
      { wait: "second-model", send: "post-switch follow up\r" },
      { wait: "FOLLOWUP-ANSWER", send: "/quit\r" },
    ]);
    assert.equal(result.code, 0, result.output);
    const request = h.requests.find((entry) => JSON.stringify(entry.messages).includes("post-switch follow up"))!;
    assert(request);
    const wire = JSON.stringify(request.messages);
    assert.doesNotMatch(wire, new RegExp(FINAL_REASONING));
    assert.match(wire, new RegExp(ANSWER_TEXT));
    assert(!wire.match(new RegExp(`"role":"assistant"[^}]*${FINAL_REASONING}`)));
    assert.match(readFileSync(sessionFile, "utf8"), new RegExp(FINAL_REASONING));
  } finally {
    await h.close();
  }
});

const COMPACT_REASONING = "REPLAY-MARKER-compact-final-reasoning";
const COMPACT_ANSWER = "REPLAY-MARKER-compact-final-answer";
const COMPACT_TOOL_REASONING = "REPLAY-MARKER-compact-tool-reasoning";

function seedCompactableHistory(h: Harness, settings: Record<string, unknown>): string {
  writeFileSync(join(h.home, ".feishu-agent", "settings.json"), JSON.stringify(settings));
  const manager = SessionManager.create(h.cwd, h.sessionDir);
  const now = Date.now();
  const assistant = (content: unknown[], stopReason: string, ts = now) =>
    ({ role: "assistant", api: "openai-completions", provider: "fake", model: "fake-model", timestamp: ts, stopReason, usage: zeroUsage, content });
  // A trailing bulky completed turn pushes the keepRecent boundary before the tool
  // turn we assert about, so the real compaction summarizes a full turn (never a
  // dangling tool result) and still includes the older final answer + tool steps.
  const bulky = `REPLAY-MARKER-compact-bulk-answer ${"word ".repeat(8000)}`;
  manager.appendMessage({ role: "user", content: "old final answer question", timestamp: now } as never);
  manager.appendMessage(assistant([{ type: "thinking", thinking: COMPACT_REASONING }, { type: "text", text: COMPACT_ANSWER }], "stop", now + 1) as never);
  manager.appendMessage({ role: "user", content: "old tool question", timestamp: now + 2 } as never);
  manager.appendMessage(assistant([{ type: "thinking", thinking: COMPACT_TOOL_REASONING }, { type: "toolCall", id: "call-c", name: "bash", arguments: { command: "echo compact-evidence" } }], "toolUse", now + 3) as never);
  manager.appendMessage({ role: "toolResult", toolCallId: "call-c", toolName: "bash", content: [{ type: "text", text: "COMPACT-TOOL-RESULT" }], isError: false, timestamp: now + 4 } as never);
  manager.appendMessage(assistant([{ type: "text", text: "compact tool turn answer" }], "stop", now + 5) as never);
  manager.appendMessage({ role: "user", content: "later bulky question", timestamp: now + 6 } as never);
  manager.appendMessage(assistant([{ type: "thinking", thinking: "REPLAY-MARKER-compact-bulk-reasoning" }, { type: "text", text: bulky }], "stop", now + 7) as never);
  return manager.getSessionFile()!;
}

function isSummaryRequest(request: WireRequest): boolean {
  // Compaction prompts ask for a "structured summary"; branch summaries ask for
  // "a structured summary of this conversation branch". Both embed serialized
  // history in a <conversation> block and run against the summarization system prompt.
  return request.raw.includes("You are a context summarization assistant") || request.raw.includes("<conversation>");
}

test("manual /compact summary request omits final-answer reasoning but keeps answer and tool evidence", async () => {
  const h = await startHarness((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sseAnswer("COMPACTION-RESPONSE-ANSWER"));
  });
  const sessionFile = seedCompactableHistory(h, feishuSettings({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 } }));
  try {
    const result = await runPty(h.cwd, ["-c"], envFor(h), [
      { wait: "compact tool turn answer", send: "/compact\r" },
      { wait: "Compacted", send: "after compact prompt\r" },
      { wait: "COMPACTION-RESPONSE-ANSWER", send: "" },
    ], 60, 3);
    assert.equal(result.code, 0, result.output);

    const summary = h.requests.find(isSummaryRequest);
    assert(summary, "a real summarization request reached the loopback model");
    const wire = summary.raw;
    assert.doesNotMatch(wire, new RegExp(COMPACT_REASONING), "final-answer reasoning absent from summary request");
    assert.match(wire, new RegExp(COMPACT_ANSWER), "final answer text present");
    assert.match(wire, /COMPACT-TOOL-RESULT/, "tool result present");
    assert.match(wire, /compact-evidence/, "tool call present");
    assert.match(wire, new RegExp(COMPACT_TOOL_REASONING), "tool-step reasoning present");
    // Positive, not pass-through: at least one assistant block lost reasoning.
    assert(!wire.includes("[Assistant thinking]: " + COMPACT_REASONING));

    assert.match(readFileSync(sessionFile, "utf8"), new RegExp(COMPACT_REASONING), "raw session record unchanged");
  } finally {
    await h.close();
  }
});

test("automatic threshold compaction applies the same rule on the real auto-compaction path", async () => {
  const h = await startHarness((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sseAnswer("AUTO-COMPACT-RESPONSE"));
  });
  const sessionFile = seedCompactableHistory(h, feishuSettings({
    compaction: { enabled: true, reserveTokens: 100000000, keepRecentTokens: 1 },
  }));
  try {
    // A new prompt after a huge-history session crosses contextWindow - reserveTokens,
    // driving Pi's built-in threshold auto-compaction before the next response.
    const result = await runPty(h.cwd, ["-c"], envFor(h), [
      { wait: "compact tool turn answer", send: "trigger auto compaction now\r" },
      { wait: "AUTO-COMPACT-RESPONSE", send: "" },
    ], 90, 3);
    assert.equal(result.code, 0, result.output);
    const summary = h.requests.find(isSummaryRequest);
    assert(summary, "automatic compaction produced a real summary model request");
    const wire = summary.raw;
    assert.doesNotMatch(wire, new RegExp(COMPACT_REASONING));
    assert.match(wire, new RegExp(COMPACT_ANSWER));
    assert.match(wire, /COMPACT-TOOL-RESULT/);
    assert.match(wire, new RegExp(COMPACT_TOOL_REASONING));
    assert.match(readFileSync(sessionFile, "utf8"), new RegExp(COMPACT_REASONING));
  } finally {
    await h.close();
  }
});

const BRANCH_REASONING = "REPLAY-MARKER-branch-final-reasoning";
const BRANCH_ANSWER = "REPLAY-MARKER-branch-final-answer";
const BRANCH_TOOL_REASONING = "REPLAY-MARKER-branch-tool-reasoning";
const BRANCH_TARGET_ANSWER = "REPLAY-MARKER-branch-target-answer";

test("branch summary request applies the same input rule when leaving a conversation branch", async () => {
  const h = await startHarness((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sseAnswer("BRANCH-POST-NAVIGATION-ANSWER"));
  });
  writeFileSync(join(h.home, ".feishu-agent", "settings.json"), JSON.stringify(feishuSettings()));

  // Build a branched tree. The resumed leaf is the abandoned branch (a tool
  // step plus a completed final answer carrying reasoning). Navigating the
  // tree back to the earlier root point asks whether to summarize that leaf.
  const manager = SessionManager.create(h.cwd, h.sessionDir);
  const now = Date.now();
  const assistant = (content: unknown[], stopReason: string, ts = now) =>
    ({ role: "assistant", api: "openai-completions", provider: "fake", model: "fake-model", timestamp: ts, stopReason, usage: zeroUsage, content });
  manager.appendMessage({ role: "user", content: "branch root question", timestamp: now } as never);
  const rootAnswerId = manager.appendMessage(assistant([{ type: "text", text: "branch root answer" }], "stop", now + 1) as never);
  // A second branch the tree selector can navigate back to.
  manager.branch(rootAnswerId);
  manager.appendMessage({ role: "user", content: "target branch question", timestamp: now + 8 } as never);
  manager.appendMessage(assistant([{ type: "text", text: BRANCH_TARGET_ANSWER }], "stop", now + 9) as never);
  // The resumed leaf: abandoned branch with tool step + final answer.
  manager.branch(rootAnswerId);
  manager.appendMessage({ role: "user", content: "abandoned branch question", timestamp: now + 2 } as never);
  manager.appendMessage(assistant([{ type: "thinking", thinking: BRANCH_TOOL_REASONING }, { type: "toolCall", id: "call-b", name: "bash", arguments: { command: "echo branch-evidence" } }], "toolUse", now + 3) as never);
  manager.appendMessage({ role: "toolResult", toolCallId: "call-b", toolName: "bash", content: [{ type: "text", text: "BRANCH-TOOL-RESULT" }], isError: false, timestamp: now + 4 } as never);
  manager.appendMessage(assistant([{ type: "text", text: "branch tool answer" }], "stop", now + 5) as never);
  manager.appendMessage({ role: "user", content: "branch final question", timestamp: now + 6 } as never);
  manager.appendMessage(assistant([{ type: "thinking", thinking: BRANCH_REASONING }, { type: "text", text: BRANCH_ANSWER }], "stop", now + 7) as never);
  const sessionFile = manager.getSessionFile()!;

  try {
    const result = await runPty(h.cwd, ["-c"], envFor(h), [
      { wait: BRANCH_ANSWER, send: "/tree\r" },
      // Navigate up 5 entries to the common ancestor (branch root answer), then confirm.
      { wait: "Session Tree", send: "\x1b[A\x1b[A\x1b[A\x1b[A\x1b[A\r" },
      { wait: "Summarize branch?", send: "\x1b[B\r" }, // choose "Summarize"
      { wait: "Navigated to selected point", send: "" },
    ], 60, 3);
    assert.equal(result.code, 0, result.output);

    const summary = h.requests.find((request) => isSummaryRequest(request));
    assert(summary, "a real branch-summary model request reached the loopback model");
    const wire = summary.raw;
    assert.doesNotMatch(wire, new RegExp(BRANCH_REASONING), "final-answer reasoning absent from branch summary");
    assert.match(wire, new RegExp(BRANCH_ANSWER), "final answer text present");
    assert.match(wire, /branch-evidence/, "tool call present");
    assert.match(wire, new RegExp(BRANCH_TOOL_REASONING), "tool-step reasoning present");
    assert.match(readFileSync(sessionFile, "utf8"), new RegExp(BRANCH_REASONING), "raw branch record unchanged");
  } finally {
    await h.close();
  }
});
