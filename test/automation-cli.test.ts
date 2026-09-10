import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hermeticEnv } from "./helpers/hermetic-env.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "dist/src/cli.js");

const MODEL_KEY_SENTINEL = "MEM0-AUTOMATION-KEY-39";
const REMOTE_SECRET_SENTINEL = "REMOTE-SECRET-SENTINEL-39";
const TOOL_OUTPUT_SENTINEL = "AUTOMATION-TOOL-OUTPUT-39";

const textResponse = (text: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
const toolResponse = (name: string, input: unknown, id: string): string => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;

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

function profileListJson(profiles: Array<[string, boolean]>): string {
  return JSON.stringify(profiles.map(([name, active]) => ({ name, appId: name, brand: "feishu", active, effective: active, effectiveSource: active ? "config" : "flag" })));
}

function makeLarkBin(bin: string, cases: string): void {
  writeFileSync(join(bin, "lark-cli"), `#!/bin/sh\ncase "$1 $2" in\n${cases}\n  *)\n    case "$1" in profile) printf '%s' "$LARK_FAKE_PROFILES";; *) echo "unexpected: $*" >&2; exit 2;; esac ;;\nesac\n`, { mode: 0o755 });
}

const DEFAULT_CASES = (profiles: Array<[string, boolean]>): string => `  "profile list") printf '%s' '${profileListJson(profiles)}' ;;`;

interface ModelServer {
  server: Server;
  port: number;
  responses: string[];
  requests: string[];
  delayMs: number;
}

function startModelServer(): Promise<ModelServer> {
  const state: ModelServer = { server: undefined as unknown as Server, port: 0, responses: [], requests: [], delayMs: 0 };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => body += chunk);
    request.on("end", () => {
      state.requests.push(body);
      const payload = state.responses.shift() ?? textResponse("UNEXPECTED-EXTRA-MODEL-REQUEST");
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(payload);
      }, state.delayMs);
    });
  });
  state.server = server;
  return new Promise((done) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    assert(address && typeof address !== "string");
    state.port = address.port;
    done(state);
  }));
}

interface Fixture {
  root: string;
  home: string;
  bin: string;
  jobs: string;
  briefing: string;
  model: ModelServer;
}

async function fixture(profiles: Array<[string, boolean]> = [["local-default", true]], cases?: string): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "feishu-automation-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const pi = join(home, ".pi", "agent");
  const feishu = join(home, ".feishu-agent");
  const jobs = join(root, "jobs");
  const briefing = join(home, "feishu-automation");
  mkdirSync(pi, { recursive: true });
  mkdirSync(feishu, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(pi, "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "not-secret" } }));
  writeFileSync(join(feishu, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-model", quietStartup: true, collapseChangelog: true }));
  writeFileSync(join(feishu, "SYSTEM.md"), "You are Feishu Agent.\n");
  mkdirSync(join(briefing, "systemd"), { recursive: true });
  writeFileSync(join(briefing, "AGENTS.md"), "BRIEFING-POLICY-SENTINEL do not overwrite\n");
  writeFileSync(join(briefing, "systemd", "feishu-briefing.service"), "briefing unit\n");
  const dir = join(home, ".config", "lark-cli");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), "{}");
  makeLarkBin(bin, cases ?? DEFAULT_CASES(profiles));

  const model = await startModelServer();
  writeFileSync(join(pi, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.port}/v1`, api: "openai-completions", models: [{ id: "fake-model", name: "Fake", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 512 }] } } }));
  return { root, home, bin, jobs, briefing, model };
}

const modelServers: Server[] = [];
test.after(async () => {
  await Promise.all(modelServers.map((server) => new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))));
});

function userPromptCount(f: Fixture): number {
  return f.model.requests.reduce((count, raw) => {
    const payload = JSON.parse(raw);
    return count + (payload.messages.at(-1)?.role === "user" ? 1 : 0);
  }, 0);
}

interface CliResult { code: number | null; stdout: string; stderr: string }

function baseEnv(f: Fixture, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return hermeticEnv({
    HOME: f.home,
    PATH: `${f.bin}${delimiter}${process.env.PATH}`,
    PI_OFFLINE: "1",
    FEISHU_AUTOMATION_HOME: f.jobs,
    ...extra,
  });
}

function runCli(f: Fixture, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): CliResult {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: f.root,
    input: options.input,
    env: baseEnv(f, options.env),
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function addJob(f: Fixture, extraArgs: string[] = [], task = "Self-contained task instructions."): CliResult {
  return runCli(f, ["automation", "add", "--name", "daily-reminder", "--at", "2030-06-01T09:00", "--prompt-stdin", ...extraArgs, "--yes"], { input: `${task}\n` });
}

test("add validates name, schedule, instructions, durations, and timezone before any mutation", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  const cases: Array<{ args: string[]; input?: string; match: RegExp }> = [
    { args: ["--name", "Bad_Name", "--at", "2030-06-01T09:00", "--prompt-stdin", "--yes"], match: /safe name/ },
    { args: ["--name", "-lead", "--at", "2030-06-01T09:00", "--prompt-stdin", "--yes"], match: /safe name|requires a value/ },
    { args: ["--name", "x".repeat(33), "--at", "2030-06-01T09:00", "--prompt-stdin", "--yes"], match: /safe name/ },
    { args: ["--name", "job", "--cron", "0 9 * * *", "--prompt-stdin", "--yes"], match: /supports one-shot jobs only|later release/i },
    { args: ["--name", "job", "--every", "90m", "--prompt-stdin", "--yes"], match: /supports one-shot jobs only|later release/i },
    { args: ["--name", "job", "--at", "2030-06-01T09:00", "--at", "2030-06-02T09:00", "--prompt-stdin", "--yes"], match: /exactly one schedule/i },
    { args: ["--name", "job", "--prompt-stdin", "--yes"], match: /exactly one schedule/i },
    { args: ["--name", "job", "--at", "not-a-time", "--prompt-stdin", "--yes"], match: /ISO 8601/ },
    { args: ["--name", "job", "--at", "2030-06-01T09:00", "--tz", "Mars/Olympus", "--prompt-stdin", "--yes"], match: /unknown timezone/i },
    { args: ["--name", "job", "--at", "2030-06-01T09:00", "--timeout", "30s", "--prompt-stdin", "--yes"], match: /positive duration/i },
    { args: ["--name", "job", "--at", "2030-06-01T09:00", "--prompt-stdin", "--yes"], input: "   \n", match: /nonempty task/ },
    { args: ["--name", "job", "--at", "2030-06-01T09:00", "--prompt-file", join(f.root, "missing.txt"), "--yes"], match: /cannot read task file/i },
    { args: ["--name", "job", "--at", "2030-06-01T09:00", "--yes"], match: /--prompt-file .*--prompt-stdin/i },
    { args: ["--name", "job", "--at", "2030-06-01T09:00", "--prompt-stdin", "--catch-up", "2h", "--yes"], match: /unknown option/i },
  ];
  for (const testCase of cases) {
    const result = runCli(f, ["automation", "add", ...testCase.args], { input: testCase.input ?? "task text\n" });
    assert.notEqual(result.code, 0, testCase.args.join(" "));
    assert.match(result.stderr, testCase.match, testCase.args.join(" "));
    assert.equal(existsSync(f.jobs), false, `workspace mutated by ${testCase.args.join(" ")}`);
  }
});

test("add rejects duplicate names, unknown subcommands and unknown options without mutation", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  assert.equal(addJob(f).code, 0);
  const duplicate = addJob(f);
  assert.notEqual(duplicate.code, 0);
  assert.match(duplicate.stderr, /already exists/i);
  assert.equal(readdirSync(join(f.jobs, "jobs")).length, 1);
  const unknown = runCli(f, ["automation", "frobnicate", "x"]);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /unknown automation command/i);
  const badFlag = runCli(f, ["automation", "add", "--name", "other", "--at", "2030-06-01T09:00", "--prompt-stdin", "--bogus", "--yes"], { input: "t\n" });
  assert.notEqual(badFlag.code, 0);
  assert.match(badFlag.stderr, /unknown option/i);
  assert.equal(readdirSync(join(f.jobs, "jobs")).length, 1);
});

test("noninteractive add without --yes fails promptly; TTY decline mutates nothing; TTY affirmation creates the job", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  const noFlag = runCli(f, ["automation", "add", "--name", "job-a", "--at", "2030-06-01T09:00", "--prompt-stdin"], { input: "task\n" });
  assert.notEqual(noFlag.code, 0);
  assert.match(noFlag.stderr, /--yes/);
  assert.equal(existsSync(f.jobs), false);

  writeFileSync(join(f.root, "task-b.txt"), "task text\n");
  const declined = await ptyRun(f, ["automation", "add", "--name", "job-b", "--at", "2030-06-01T09:00", "--prompt-file", join(f.root, "task-b.txt")], "", /Create this Automation Job\?/i, "n");
  assert.notEqual(declined.code, 0);
  assert.match(declined.output, /Declined/i);
  assert.equal(existsSync(f.jobs), false);

  // Interactive stdin cannot both hold task text and answer the prompt: a TTY
  // --prompt-stdin call fails fast with a --prompt-file pointer.
  const ttyStdin = await ptyRun(f, ["automation", "add", "--name", "job-d", "--at", "2030-06-01T09:00", "--prompt-stdin", "--yes"], "", /Create this Automation Job\?/, "n");
  assert.notEqual(ttyStdin.code, 0);
  assert.match(ttyStdin.output, /--prompt-file/);
  assert.equal(existsSync(join(f.jobs, "jobs", "job-d")), false);

  writeFileSync(join(f.root, "task-c.txt"), "task text\n");
  const accepted = await ptyRun(f, ["automation", "add", "--name", "job-c", "--at", "2030-06-01T09:00", "--prompt-file", join(f.root, "task-c.txt")], "", /Create this Automation Job\?/i, "y");
  assert.equal(accepted.code, 0, accepted.output);
  assert.match(accepted.output, /2030-06-01 09:00/);
  assert.match(accepted.output, /Asia\/Shanghai/);
  assert.match(accepted.output, /Trigger is not running/i);
  assert.match(accepted.output, /local-default/);
});

test("receipt, show, and list expose the stored plan; seeded standing instructions never overwrite user edits; Briefing is untouched", async () => {
  const f = await fixture([["local-default", true], ["extra-profile", false]]);
  modelServers.push(f.model.server);
  const result = addJob(f, ["--tz", "Asia/Tokyo", "--timeout", "20m", "--lark-profile", "extra-profile"], "Fixed target task with instructions.\n");
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.name, "daily-reminder");
  assert.equal(receipt.profile, "extra-profile");
  assert.equal(receipt.schedule.kind, "oneshot");
  assert.equal(receipt.schedule.timeZone, "Asia/Tokyo");
  assert.equal(receipt.timeoutMinutes, 20);
  assert.equal(receipt.triggerRunning, false);
  assert.match(receipt.schedule.resolvedLocal, /2030-06-01 09:00/);
  assert.match(result.stderr, /Trigger is not running/);

  const standing = join(f.jobs, "AGENTS.md");
  const standingText = readFileSync(standing, "utf8");
  assert.match(standingText, /bot/i);
  assert.match(standingText, /append-only/i);
  assert.match(standingText, /must not switch identities|do not switch identities/i);

  const show = runCli(f, ["automation", "show", "daily-reminder"]);
  assert.equal(show.code, 0, show.stderr);
  const shown = JSON.parse(show.stdout);
  assert.equal(shown.task, "Fixed target task with instructions.");
  assert.equal(shown.profile, "extra-profile");
  assert.equal(shown.timeoutMinutes, 20);
  assert.equal(shown.schedule.timeZone, "Asia/Tokyo");
  assert.equal(shown.latestRun, null);

  const list = runCli(f, ["automation", "list"]);
  assert.equal(list.code, 0, list.stderr);
  const jobs = JSON.parse(list.stdout).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, "daily-reminder");

  writeFileSync(standing, `${standingText}\nUSER-EDIT-SENTINEL\n`);
  const second = runCli(f, ["automation", "add", "--name", "second-job", "--at", "2030-07-01T09:00", "--prompt-stdin", "--yes"], { input: "second task\n" });
  assert.equal(second.code, 0, second.stderr);
  assert.match(readFileSync(standing, "utf8"), /USER-EDIT-SENTINEL/);

  assert.equal(readFileSync(join(f.briefing, "AGENTS.md"), "utf8"), "BRIEFING-POLICY-SENTINEL do not overwrite\n");
  assert.equal(readFileSync(join(f.briefing, "systemd", "feishu-briefing.service"), "utf8"), "briefing unit\n");
});

test("profile resolves through selector, environment, and local default; unknown/unresolvable profiles fail without discovery", async () => {
  const f = await fixture([["local-default", true], ["extra-profile", false]]);
  modelServers.push(f.model.server);
  const explicit = addJob(f, ["--lark-profile", "extra-profile"]);
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).profile, "extra-profile");

  const fromEnv = runCli(f, ["automation", "add", "--name", "env-job", "--at", "2030-06-01T09:00", "--prompt-stdin", "--yes"], { input: "t\n", env: { LARK_PROFILE: "extra-profile" } });
  assert.equal(fromEnv.code, 0, fromEnv.stderr);
  assert.equal(JSON.parse(fromEnv.stdout).profile, "extra-profile");

  const local = runCli(f, ["automation", "add", "--name", "default-job", "--at", "2030-06-01T09:00", "--prompt-stdin", "--yes"], { input: "t\n" });
  assert.equal(local.code, 0, local.stderr);
  assert.equal(JSON.parse(local.stdout).profile, "local-default");

  const unknown = runCli(f, ["automation", "add", "--name", "bad-profile", "--at", "2030-06-01T09:00", "--prompt-stdin", "--lark-profile", "ghost", "--yes"], { input: "t\n" });
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /--lark-profile/);
  assert.equal(existsSync(join(f.jobs, "jobs", "bad-profile")), false);

  makeLarkBin(f.bin, '  * ) echo "discovery is forbidden" >&2; exit 7 ;;');
  const unresolved = runCli(f, ["automation", "add", "--name", "no-profile", "--at", "2030-06-01T09:00", "--prompt-stdin", "--yes"], { input: "t\n" });
  assert.notEqual(unresolved.code, 0);
  assert.match(unresolved.stderr, /--lark-profile/);
  assert.equal(existsSync(join(f.jobs, "jobs", "no-profile")), false);
});

function runAutomationAsync(f: Fixture, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [cli, "automation", ...args], {
      cwd: f.root,
      env: baseEnv(f, {
        MEM0_API_KEY: MODEL_KEY_SENTINEL, MEM0_API_HOST: `http://127.0.0.1:${f.model.port}`,
        FEISHU_REMOTE: "1", FEISHU_REMOTE_APP_SECRET: REMOTE_SECRET_SENTINEL, ...extra,
      }),
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

test("manual run starts a fresh unattended memory-less Print child with the saved profile, scratch area, and recorded artifacts", async () => {
  const f = await fixture([["local-default", true], ["bound-profile", false]]);
  modelServers.push(f.model.server);
  const larkTrace = join(f.root, "lark-trace.log");
  makeLarkBin(f.bin, `  "profile list") printf '%s' '${profileListJson([["local-default", true], ["bound-profile", false]])}' ;;
  * ) printf 'LARK_PROFILE=%s|%s\\n' "$LARK_PROFILE" "$*" >> "$LARK_TRACE"; printf '${TOOL_OUTPUT_SENTINEL}' ;;`);
  assert.equal(addJob(f, ["--lark-profile", "bound-profile"], "Use the Bash tool to run: lark-cli im send --as bot; then report DONE-MANUAL-RUN\n").code, 0);
  f.model.responses.push(toolResponse("bash", { command: "lark-cli im send --as bot" }, "bash-1"), textResponse("DONE-MANUAL-RUN"));
  const result = await runAutomationAsync(f, ["run", "daily-reminder"], { LARK_TRACE: larkTrace, LARK_PROFILE: "local-default" });
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.outcome, "completed");
  assert.match(receipt.runId, /^\d{8}T\d{6}Z-/);
  assert.match(result.stdout, /not proof of successful Feishu delivery/i);

  const trace = readFileSync(larkTrace, "utf8");
  assert.match(trace, /LARK_PROFILE=bound-profile/);
  assert.match(trace, /im send --as bot/);

  assert.equal(userPromptCount(f), 1, "a manual run starts one fresh Print turn, not a replay");
  const modelPayload = JSON.parse(f.model.requests[0]);
  const systemText = modelPayload.messages.filter((message: { role: string }) => message.role === "system").map((message: { content: unknown }) => JSON.stringify(message.content)).join("\n");
  assert.match(systemText, /append-only/i);
  const userPrompt = JSON.stringify(modelPayload.messages.at(-1).content);
  assert.match(userPrompt, /Use the Bash tool/);
  assert.match(userPrompt, /scratch/);
  assert.match(userPrompt, /DONE-MANUAL-RUN/);
  // No previous conversation is resumed: only system + the one new user turn.
  const roles = modelPayload.messages.map((message: { role: string }) => message.role);
  assert.deepEqual(roles, ["system", "user"]);

  const runDir = join(f.jobs, "jobs", "daily-reminder", "runs");
  const artifacts = files(runDir);
  assert(artifacts.some((path) => path.endsWith("stdout.log")));
  assert(artifacts.some((path) => path.endsWith("stderr.log")));
  for (const path of files(f.jobs)) {
    const text = readFileSync(path, "utf8");
    assert.doesNotMatch(text, new RegExp(MODEL_KEY_SENTINEL), path);
    assert.doesNotMatch(text, new RegExp(REMOTE_SECRET_SENTINEL), path);
  }
});

test("manual run records failure without automatic replay; a second explicit run is a separate attempt", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  assert.equal(addJob(f, [], "Tidy up the documents please.\n").code, 0);
  // A vague job request cannot authorize the model-added destructive --yes call:
  // the existing high-risk guard blocks it and the fresh Print child exits nonzero.
  f.model.responses.push(toolResponse("bash", { command: "lark-cli doc delete doc-1 --as user --yes" }, "destructive-1"));
  const failed = await runAutomationAsync(f, ["run", "daily-reminder"]);
  assert.equal(failed.code, 1, failed.stderr);
  const receipt = JSON.parse(failed.stdout);
  assert.equal(receipt.outcome, "failed");
  assert.match(receipt.note, /not proof of successful Feishu delivery/i);
  const failedRunLog = readFileSync(join(f.jobs, "jobs", "daily-reminder", "runs", `${receipt.runId}.stderr.log`), "utf8");
  assert.match(failedRunLog, /Blocked lark-cli --yes/);
  assert.equal(userPromptCount(f), 1, "a failed attempt was automatically replayed");

  f.model.responses.push(textResponse("SECOND-MANUAL-ATTEMPT"));
  const retry = await runAutomationAsync(f, ["run", "daily-reminder"]);
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).outcome, "completed");
  assert.equal(userPromptCount(f), 2);
});

test("manual run that overruns its job timeout is stopped and recorded as timeout, without replay", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  assert.equal(addJob(f, ["--timeout", "1m"], "slow task\n").code, 0);
  // The model server holds the connection open, so the child is still active
  // when the test-shortened timeout fires and the supervisor bounds it.
  f.model.delayMs = 120_000;
  f.model.responses.push(textResponse("SLOW-RESPONSE"));
  const started = Date.now();
  const timed = await runAutomationAsync(f, ["run", "daily-reminder"], { FEISHU_AUTOMATION_TIMEOUT_MS: "8000" });
  assert.equal(timed.code, 124, timed.stderr);
  assert.equal(JSON.parse(timed.stdout).outcome, "timeout");
  assert.ok(Date.now() - started < 30_000, "timeout was not bounded");
  // Exactly one request was in flight; the bounded stop prevents any replay.
  assert.equal(f.model.requests.length, 1);
});

test("concurrent manual calls for the same job cannot overlap", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  assert.equal(addJob(f, [], "Overlap probe task.\n").code, 0);

  let openGate: () => void = () => {};
  const gate = new Promise<void>((resolveGate) => { openGate = resolveGate; });
  const gateServer = createServer((request, response) => {
    request.resume();
    void gate.then(() => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(textResponse("FIRST-HOLDER"));
    });
  });
  await new Promise<void>((done) => gateServer.listen(0, "127.0.0.1", done));
  modelServers.push(gateServer);
  const gateAddress = gateServer.address();
  assert(gateAddress && typeof gateAddress !== "string");

  const heldHome = join(f.root, "held-home");
  const heldBin = join(f.root, "held-bin");
  const pi = join(heldHome, ".pi", "agent");
  mkdirSync(pi, { recursive: true });
  mkdirSync(join(heldHome, ".feishu-agent"), { recursive: true });
  mkdirSync(heldBin, { recursive: true });
  writeFileSync(join(pi, "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "x" } }));
  writeFileSync(join(pi, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${gateAddress.port}/v1`, api: "openai-completions", models: [{ id: "fake-model", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 256 }] } } }));
  writeFileSync(join(heldHome, ".feishu-agent", "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-model" }));
  writeFileSync(join(heldHome, ".feishu-agent", "SYSTEM.md"), "You are Feishu Agent.\n");
  makeLarkBin(heldBin, DEFAULT_CASES([["local-default", true]]));

  const first = spawn(process.execPath, [cli, "automation", "run", "daily-reminder"], {
    cwd: f.root,
    env: hermeticEnv({ HOME: heldHome, PATH: `${heldBin}${delimiter}${process.env.PATH}`, PI_OFFLINE: "1", FEISHU_AUTOMATION_HOME: f.jobs, LARK_TRACE: join(f.root, "held-trace.log") }),
  });
  let firstStderr = "";
  first.stderr.on("data", (chunk) => firstStderr += chunk);
  await waitFor(() => existsSync(join(f.jobs, "jobs", "daily-reminder", "run.lock")));
  const second = runCli(f, ["automation", "run", "daily-reminder"]);
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /already running/i);
  openGate();
  await new Promise<void>((done) => first.on("close", () => done()));
  assert.doesNotMatch(firstStderr, /already running/);
});

test("manual run with a simulated tool side effect followed by failure is recorded once and never replayed", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  const sideEffect = join(f.root, "side-effect.log");
  makeLarkBin(f.bin, `  "profile list") printf '%s' '${profileListJson([["local-default", true]])}' ;;
  "--version ") echo "lark-cli 1.0.0" ;;
  "skills list") echo "[]" ;;
  "im send") printf 'SIDE-EFFECT-MARKER\\n' >> "${sideEffect}"; echo sent ;;
  * ) echo sent ;;`);
  assert.equal(addJob(f, [], "Tidy up the documents please.\n").code, 0);
  // Turn 1: the child performs one ordinary (non-destructive) fake-lark side
  // effect; the very next call is the guarded destructive one, which ends the
  // turn nonzero. No second turn may re-execute the first effect.
  f.model.responses.push(
    toolResponse("bash", { command: "lark-cli im send --as bot" }, "side-1"),
  );
  // After the tool result, the fake model asks for the destructive call, then stops.
  f.model.responses.push(toolResponse("bash", { command: "lark-cli doc delete doc-1 --as user --yes" }, "destructive-1"));
  const failed = await runAutomationAsync(f, ["run", "daily-reminder"], { LARK_TRACE: sideEffect });
  assert.equal(failed.code, 1, failed.stderr);
  assert.equal(JSON.parse(failed.stdout).outcome, "failed");
  const markerCount = readFileSync(sideEffect, "utf8").trim().split("\n").length;
  assert.equal(markerCount, 1, "the run replayed and duplicated the external side effect");
  const receipt = JSON.parse(failed.stdout);
  const stderrLog = readFileSync(join(f.jobs, "jobs", "daily-reminder", "runs", `${receipt.runId}.stderr.log`), "utf8");
  assert.match(stderrLog, /Blocked lark-cli --yes/);
});

test("list preserves and reports one corrupt or unsupported-version record without hiding healthy jobs", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  assert.equal(addJob(f).code, 0);
  const corruptDir = join(f.jobs, "jobs", "corrupt-job");
  mkdirSync(corruptDir, { recursive: true });
  writeFileSync(join(corruptDir, "job.json"), "{ not valid json");
  const result = runCli(f, ["automation", "list"]);
  assert.equal(result.code, 0, result.stderr);
  const names = JSON.parse(result.stdout).jobs.map((job: { name: string }) => job.name);
  assert.deepEqual(names, ["daily-reminder"]);
  assert.match(result.stderr, /corrupt/);
  // Evidence is preserved, never deleted.
  assert.equal(readFileSync(join(corruptDir, "job.json"), "utf8"), "{ not valid json");
});

test("creation accepts lark-cli's unnamed default profile by persisting its app id", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  makeLarkBin(f.bin, `  "profile list") printf '%s' '${JSON.stringify([{ appId: "cli_unnamed123", brand: "feishu", active: true, effective: true }]).replace(/'/g, "'\\''")}' ;;`);
  const result = addJob(f);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).profile, "cli_unnamed123");
});

test("manual run neither consumes nor re-arms the one-shot and discloses the scheduled occurrence", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  assert.equal(addJob(f).code, 0);
  f.model.responses.push(textResponse("MANUAL-OK"));
  const result = await runAutomationAsync(f, ["run", "daily-reminder"]);
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.match(receipt.scheduleNotice, /scheduled occurrence|remains eligible/i);
  const job = JSON.parse(readFileSync(join(f.jobs, "jobs", "daily-reminder", "job.json"), "utf8"));
  assert.equal(job.schedule.kind, "oneshot");
  assert.equal(job.schedule.dueMs, Date.parse("2030-06-01T01:00:00.000Z"));
  assert.equal(job.runs.length, 1);
  const show = runCli(f, ["automation", "show", "daily-reminder"]);
  assert.equal(JSON.parse(show.stdout).latestRun.outcome, "completed");
});

test("creation neither runs a task nor starts a service; inherited unattended processes cannot manage jobs", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  const created = addJob(f);
  assert.equal(created.code, 0, created.stderr);
  assert.equal(f.model.requests.length, 0, "creation started a model turn");
  assert.equal(existsSync(join(f.jobs, "trigger.pid")), false);

  const blockedAdd = runCli(f, ["automation", "add", "--name", "x", "--at", "2030-06-01T09:00", "--prompt-stdin", "--yes"], { input: "t\n", env: { FEISHU_UNATTENDED: "1" } });
  assert.notEqual(blockedAdd.code, 0);
  assert.match(blockedAdd.stderr, /unattended/i);
  const blockedRun = runCli(f, ["automation", "run", "daily-reminder"], { env: { FEISHU_UNATTENDED: "1" } });
  assert.notEqual(blockedRun.code, 0);
  assert.match(blockedRun.stderr, /unattended/i);
  const list = runCli(f, ["automation", "list"], { env: { FEISHU_UNATTENDED: "1" } });
  assert.equal(list.code, 0);
});

function ptyRun(f: Fixture, args: string[], input: string, ready: RegExp, reply: string): Promise<{ code: number | null; output: string }> {
  const python = [
    "import os,pty,re,select,sys,time",
    "cwd=sys.argv[1]; exe=sys.argv[2]; argv=eval(sys.argv[3]); stdin=sys.argv[4]; pattern=sys.argv[5]; reply=sys.argv[6]",
    "pid,fd=pty.fork()",
    "if pid==0:",
    " os.chdir(cwd); os.execvpe(exe,[exe]+argv,os.environ)",
    "sent=False; replied=False; out=b''; end=time.time()+30",
    "os.write(fd, stdin.encode())",
    "while time.time()<end:",
    " r,_,_=select.select([fd],[],[],0.1)",
    " if r:",
    "  try: out+=os.read(fd,65536)",
    "  except OSError:",
    "   _,st=os.waitpid(pid,0); sys.stdout.buffer.write(out); sys.exit(os.waitstatus_to_exitcode(st))",
    " if not replied and re.search(pattern,out.decode('utf-8','replace'),re.I):",
    "  time.sleep(0.2); os.write(fd,reply.encode()+b'\\n'); replied=True",
    " p,st=os.waitpid(pid,os.WNOHANG)",
    " if p and replied:",
    "  sys.stdout.buffer.write(out); sys.exit(os.waitstatus_to_exitcode(st))",
    " if p and not replied:",
    "  sys.stdout.buffer.write(out); sys.exit(os.waitstatus_to_exitcode(st))",
    "os.kill(pid,15); sys.stdout.buffer.write(out); sys.exit(124)",
  ].join("\n");
  return new Promise((done) => {
    const child = spawn("python3", ["-c", python, f.root, process.execPath, JSON.stringify([cli, ...args]), input, ready.source, reply], {
      env: baseEnv(f, { TERM: "xterm-256color", COLUMNS: "120", LINES: "40" }),
    });
    let output = "";
    child.stdout.on("data", (chunk) => output += chunk);
    child.stderr.on("data", (chunk) => output += chunk);
    child.on("close", (code) => done({ code, output }));
  });
}

async function waitFor(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
  throw new Error("condition was not met before timeout");
}
