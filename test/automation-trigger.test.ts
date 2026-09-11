// Foreground Trigger behavior for one-shot Automation Jobs (SPEC §16.5, #40).
// One controlled clock seam drives the real `feishu automation serve` process:
// FEISHU_AUTOMATION_CLOCK_FILE points at a frozen {"now": <epoch ms>} fixture
// the test rewrites between ticks. No public clock flags, no real waiting.

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hermeticEnv } from "./helpers/hermetic-env.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "dist/src/cli.js");

const DUE_MS = Date.parse("2030-06-01T01:00:00.000Z"); // 09:00 Asia/Shanghai
const MIN = 60_000;
const SECRET_SENTINEL = "TRIGGER-SECRET-SENTINEL-40";

const textResponse = (text: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;

interface GateJob { response: string; gate: Promise<void>; release: () => void }

function gate(response: string, hold = false): GateJob {
  let release = (): void => {};
  const gate = new Promise<void>((done) => { release = done; });
  const job: GateJob = { response, gate, release };
  if (!hold) setImmediate(release);
  return job;
}

interface GateServer { server: Server; port: number; jobs: GateJob[]; requests: string[] }

function startGateServer(): Promise<GateServer> {
  const state: GateServer = { server: undefined as unknown as Server, port: 0, jobs: [], requests: [] };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => body += chunk);
    request.on("end", () => {
      state.requests.push(body);
      const job = state.jobs.shift();
      const reply = job?.response ?? textResponse("UNEXPECTED-EXTRA-MODEL-REQUEST");
      if (!job) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(reply);
        return;
      }
      void job.gate.then(() => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(reply);
      });
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
  root: string; home: string; bin: string; jobs: string; model: GateServer; clockFile: string;
}

function profileJson(): string {
  return JSON.stringify([{ name: "local-default", appId: "local-default", brand: "feishu", active: true, effective: true, effectiveSource: "config" }]);
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "feishu-trigger-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const pi = join(home, ".pi", "agent");
  const feishu = join(home, ".feishu-agent");
  const jobs = join(root, "jobs");
  mkdirSync(pi, { recursive: true });
  mkdirSync(feishu, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(pi, "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "not-secret" } }));
  writeFileSync(join(feishu, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-model", quietStartup: true, collapseChangelog: true }));
  writeFileSync(join(feishu, "SYSTEM.md"), "You are Feishu Agent.\n");
  const larkDir = join(home, ".config", "lark-cli");
  mkdirSync(larkDir, { recursive: true });
  writeFileSync(join(larkDir, "config.json"), "{}");
  writeFileSync(join(bin, "lark-cli"), `#!/bin/sh\ncase "$1 $2" in\n  "profile list") printf '%s' '${profileJson()}' ;;\n  *) echo "unexpected: $*" >&2; exit 2 ;;\nesac\n`, { mode: 0o755 });
  const model = await startGateServer();
  writeFileSync(join(pi, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.port}/v1`, api: "openai-completions", models: [{ id: "fake-model", name: "Fake", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 512 }] } } }));
  const clockFile = join(root, "clock.json");
  writeFileSync(clockFile, JSON.stringify({ now: DUE_MS - 10 * MIN }));
  return { root, home, bin, jobs, model, clockFile };
}

const gateServers: Server[] = [];
const spawnedServes: ChildProcess[] = [];
const orphanSupervisors: ChildProcess[] = [];
test.after(async () => {
  // Hard-killed crash-test serves, detached manual children, and their
  // supervisors must not outlive the suite; graceful stops already reaped the
  // rest.
  for (const supervisor of orphanSupervisors) {
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      try { supervisor.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }
  for (const serve of spawnedServes) {
    if (serve.exitCode === null && serve.signalCode === null) {
      try { serve.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }
  await Promise.all(gateServers.map((server) => new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))));
});

function baseEnv(f: Fixture, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return hermeticEnv({
    HOME: f.home,
    PATH: `${f.bin}${delimiter}${process.env.PATH}`,
    PI_OFFLINE: "1",
    FEISHU_AUTOMATION_HOME: f.jobs,
    FEISHU_AUTOMATION_CLOCK_FILE: f.clockFile,
    ...extra,
  });
}

function runCli(f: Fixture, args: string[], extra: NodeJS.ProcessEnv = {}): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: f.root, env: baseEnv(f, extra) });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runCliAsync(f: Fixture, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: f.root, env: baseEnv(f), stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function addJob(f: Fixture, name: string, extraArgs: string[] = [], task = "Self-contained scheduled task."): void {
  const result = spawnSync(process.execPath, [cli, "automation", "add", "--name", name, "--at", "2030-06-01T09:00", "--prompt-stdin", ...extraArgs, "--yes"], {
    encoding: "utf8", cwd: f.root, input: `${task}\n`, env: baseEnv(f),
  });
  assert.equal(result.status, 0, result.stderr);
}

function setClock(f: Fixture, ms: number): void {
  const staged = `${f.clockFile}.next`;
  writeFileSync(staged, JSON.stringify({ now: ms }));
  renameSync(staged, f.clockFile);
}

interface Serve { child: ChildProcess; stderr: string }

function startServe(f: Fixture, extra: NodeJS.ProcessEnv = {}): Serve {
  const child = spawn(process.execPath, [cli, "automation", "serve"], { cwd: f.root, env: baseEnv(f, extra), stdio: ["ignore", "pipe", "pipe"] });
  spawnedServes.push(child);
  child.stdout.resume();
  const serve: Serve = { child, stderr: "" };
  child.stderr.on("data", (chunk) => { serve.stderr += chunk; });
  child.stdout.on("data", () => {});
  return serve;
}

async function waitStarted(serve: Serve): Promise<void> {
  await waitFor(() => /Trigger started/i.test(serve.stderr));
}

function stopServe(serve: Serve, signal: NodeJS.Signals = "SIGTERM"): Promise<number | null> {
  const child = serve.child;
  return new Promise((done) => {
    child.on("close", (code) => done(code));
    child.kill(signal);
  });
}

function schedulePath(f: Fixture, name: string): string {
  return join(f.jobs, "jobs", name, "schedule.json");
}

function occurrence(f: Fixture, name: string): Record<string, unknown> {
  const result = runCli(f, ["automation", "show", name]);
  assert.equal(result.code, 0, result.stderr);
  const occ = JSON.parse(result.stdout).scheduleOccurrence;
  assert(occ, "no scheduled occurrence was reported by the CLI");
  return occ;
}

async function waitFor(predicate: () => boolean, attempts = 150): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
  throw new Error("condition was not met before timeout");
}

async function settle(f: Fixture, name: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const result = await runCliAsync(f, ["automation", "show", name]);
    assert.equal(result.code, 0, result.stderr);
    const occ = JSON.parse(result.stdout).scheduleOccurrence;
    if (occ?.status === "settled") return occ;
  }
  throw new Error(`CLI did not report a settled occurrence for ${name}`);
}

test("serve dispatches a due one-shot exactly once, never early; clock rollback does not replay it", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  f.model.jobs.push(gate(textResponse("DUE-RESPONSE")));
  addJob(f, "job-a");

  const serve = startServe(f);
  await waitStarted(serve);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(f.model.requests.length, 0, "dispatched before the due instant");
  assert.equal(JSON.parse(runCli(f, ["automation", "show", "job-a"]).stdout).scheduledState, "future");

  setClock(f, DUE_MS);
  await waitFor(() => f.model.requests.length === 1);
  const occ = await settle(f, "job-a");
  assert.equal(occ.outcome, "completed");
  assert.equal(typeof occ.runId, "string");

  setClock(f, DUE_MS - 60 * MIN); // clock rolled back before due
  assert.equal(JSON.parse(runCli(f, ["automation", "show", "job-a"]).stdout).scheduledState, "consumed");
  setClock(f, DUE_MS + 30 * MIN); // and forward again, still within window
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(f.model.requests.length, 1, "a settled occurrence was redispatched");

  const code = await stopServe(serve);
  assert.equal(code, 0);
  const job = JSON.parse(runCli(f, ["automation", "show", "job-a"]).stdout);
  assert.equal(job.recentRuns.length, 1);
  assert.equal(job.recentRuns[0].trigger, "scheduled");
});

test("restart within the lateness window catches up; past the window it is recorded expired, retained, and not failed", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  f.model.jobs.push(gate(textResponse("CATCHUP")));
  addJob(f, "late-job");

  setClock(f, DUE_MS + 120 * MIN); // the exact cutoff is inclusive
  const serve = startServe(f);
  await waitStarted(serve);
  await waitFor(() => f.model.requests.length === 1);
  assert.equal((await settle(f, "late-job")).outcome, "completed");
  await stopServe(serve);

  // A second job whose whole window elapsed while no Trigger was alive.
  addJob(f, "expired-job");
  setClock(f, DUE_MS + 120 * MIN + 1); // one millisecond beyond the original cutoff
  const replayed = startServe(f);
  await waitStarted(replayed);
  const expired = await settle(f, "expired-job");
  assert.equal(expired.outcome, "expired");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(f.model.requests.length, 1, "an expired one-shot was dispatched");
  await stopServe(replayed);

  const list = JSON.parse(runCli(f, ["automation", "list"]).stdout).jobs;
  const expiredSummary = list.find((j: { name: string }) => j.name === "expired-job");
  assert.equal(expiredSummary.scheduledState, "expired");
  const show = JSON.parse(runCli(f, ["automation", "show", "expired-job"]).stdout);
  assert.equal(show.scheduleOccurrence.outcome, "expired");
});

test("crash after durable dispatch is never replayed; crash before dispatch still fires once on restart", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  const held = gate(textResponse("HOLD-THEN-ORPHAN"), true);
  f.model.jobs.push(held);
  addJob(f, "crash-job");

  setClock(f, DUE_MS);
  const serve = startServe(f);
  await waitStarted(serve);
  await waitFor(() => f.model.requests.length === 1);
  await waitFor(() => (occurrence(f, "crash-job").childPid as number) > 0);
  const orphanPid = occurrence(f, "crash-job").childPid as number;

  await stopServe(serve, "SIGKILL"); // hard crash while the owned child is mid-run
  // The detached orphan is a real live process; end it to simulate machine-level cleanup.
  process.kill(orphanPid, "SIGKILL");
  await waitFor(() => { try { process.kill(orphanPid, 0); return false; } catch { return true; } });

  const restarted = startServe(f);
  await waitStarted(restarted);
  const recovered = await settle(f, "crash-job");
  assert.equal(recovered.outcome, "unknown");
  setClock(f, DUE_MS + 60 * MIN);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(f.model.requests.length, 1, "an uncertain started occurrence was caught up as never-started");
  await stopServe(restarted);

  // Fresh job: crash before its due instant must not consume the occurrence.
  addJob(f, "fresh-job");
  setClock(f, DUE_MS - 5 * MIN);
  const early = startServe(f);
  await waitStarted(early);
  await stopServe(early, "SIGKILL");
  const again = startServe(f);
  await waitStarted(again);
  setClock(f, DUE_MS);
  f.model.jobs.push(gate(textResponse("FRESH-FIRE")));
  await waitFor(() => f.model.requests.length === 2);
  assert.equal((await settle(f, "fresh-job")).outcome, "completed");
  await stopServe(again);
});

test("only one Trigger owns a workspace; a second owner exits and cannot double-dispatch", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  f.model.jobs.push(gate(textResponse("OWNED")));
  addJob(f, "owned-job");

  const first = startServe(f);
  await waitStarted(first);
  const second = spawnSync(process.execPath, [cli, "automation", "serve"], { encoding: "utf8", cwd: f.root, env: baseEnv(f) });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /already running/i);

  setClock(f, DUE_MS);
  await waitFor(() => f.model.requests.length === 1);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(f.model.requests.length, 1);
  assert.match(first.stderr, /Trigger started/);
  await stopServe(first);
});

test("scheduled firing during an active same-job manual run is overlap-skipped and not queued; manual during scheduled is already-running", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addJob(f, "race-job", ["--timeout", "1h"], "Use the Bash tool to run: lark-cli im send --as bot; then report done\n");

  const manualGate = gate(textResponse("MANUAL-HOLDER"), true);
  f.model.jobs.push(manualGate);
  const manual = spawn(process.execPath, [cli, "automation", "run", "race-job"], { cwd: f.root, env: baseEnv(f), stdio: ["ignore", "pipe", "pipe"] });
  let manualErr = "";
  manual.stderr.on("data", (c) => { manualErr += c; });
  await waitFor(() => f.model.requests.length === 1);

  setClock(f, DUE_MS);
  const serve = startServe(f);
  await waitStarted(serve);
  const skipped = await settle(f, "race-job");
  assert.equal(skipped.outcome, "overlap-skipped");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(f.model.requests.length, 1, "the skipped occurrence started a scheduled child");

  // A second manual attempt while the first manual run is active is also refused.
  const refused = runCli(f, ["automation", "run", "race-job"]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /already running/i);

  manualGate.release();
  await new Promise<void>((done) => manual.on("close", () => done()));
  setClock(f, DUE_MS + 30 * MIN); // still inside the window, but a skip is not queued
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(f.model.requests.length, 1);
  assert.doesNotMatch(manualErr, /already running/i);
  await stopServe(serve);
});

test("capacity is two different jobs across scheduled and manual callers; waiting keeps the original deadline", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addJob(f, "job-a");
  addJob(f, "job-b");
  addJob(f, "job-c");
  addJob(f, "job-d", ["--catch-up", "1m"]); // one-minute window

  const gateA = gate(textResponse("A"), true);
  const gateB = gate(textResponse("B"), true);
  f.model.jobs.push(gateA, gateB);
  setClock(f, DUE_MS);
  const serve = startServe(f);
  await waitStarted(serve);
  await waitFor(() => f.model.requests.length === 2);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(f.model.requests.length, 2, "a third scheduled job exceeded workspace capacity");

  // An independent manual caller shares the capacity and is refused while full.
  const full = runCli(f, ["automation", "run", "job-c"]);
  assert.notEqual(full.code, 0);
  assert.match(full.stderr, /capacity/i);

  // Waiting does not extend the deadline: d's short window expires while full.
  setClock(f, DUE_MS + 5 * MIN);
  assert.equal((await settle(f, "job-d")).outcome, "expired");

  // Queue C's reply before releasing either held response. Requests from A
  // and B can arrive in either order; releasing both removes that ambiguity.
  const gateC = gate(textResponse("C"));
  f.model.jobs.push(gateC);
  gateA.release();
  gateB.release();
  await waitFor(() => f.model.requests.length === 3);
  assert.equal((await settle(f, "job-c")).outcome, "completed");
  await settle(f, "job-b");
  await stopServe(serve);
});

test("two independent manual runs retain both slots across Trigger restart", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  for (const name of ["manual-a", "manual-b", "waiting-job"]) addJob(f, name, ["--timeout", "1h"]);
  const gateA = gate(textResponse("MANUAL-A"), true);
  const gateB = gate(textResponse("MANUAL-B"), true);
  f.model.jobs.push(gateA, gateB);
  const manualA = runCliAsync(f, ["automation", "run", "manual-a"]);
  await waitFor(() => f.model.requests.length === 1);
  const manualB = runCliAsync(f, ["automation", "run", "manual-b"]);
  await waitFor(() => f.model.requests.length === 2);
  const full = runCli(f, ["automation", "run", "waiting-job"]);
  assert.notEqual(full.code, 0);
  assert.match(full.stderr, /capacity/);

  setClock(f, DUE_MS);
  const serving = startServe(f);
  await waitStarted(serving);
  assert.equal((await settle(f, "manual-a")).outcome, "overlap-skipped");
  assert.equal((await settle(f, "manual-b")).outcome, "overlap-skipped");
  assert.equal(f.model.requests.length, 2);
  await stopServe(serving);

  setClock(f, DUE_MS + 30 * MIN);
  const restarted = startServe(f);
  await waitStarted(restarted);
  try {
    const waiting = JSON.parse((await runCliAsync(f, ["automation", "show", "waiting-job"])).stdout);
    assert.equal(waiting.scheduledState, "due");
    assert.equal(waiting.scheduleOccurrence, null);
    assert.equal(f.model.requests.length, 2, "restart freed live independent manual capacity");
    f.model.jobs.push(gate(textResponse("WAITING-ADMITTED")));
    gateA.release();
    assert.equal((await manualA).code, 0);
    await waitFor(() => f.model.requests.length === 3);
    assert.equal((await settle(f, "waiting-job")).outcome, "completed");
  } finally {
    gateA.release();
    gateB.release();
    assert.equal((await manualB).code, 0);
    await stopServe(restarted);
  }
});

test("Trigger shutdown bounds its owned children and records unknown, but never stops an independent manual run", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addJob(f, "owned-child");
  addJob(f, "manual-child", ["--timeout", "1h"]);

  const scheduledGate = gate(textResponse("SCHEDULED-HOLD"), true);
  const manualGate = gate(textResponse("MANUAL-HOLD"), true);
  f.model.jobs.push(manualGate, scheduledGate);

  const manual = spawn(process.execPath, [cli, "automation", "run", "manual-child"], { cwd: f.root, env: baseEnv(f), stdio: "ignore" });
  const manualDone = new Promise<number | null>((done) => manual.once("close", done));
  orphanSupervisors.push(manual);
  await waitFor(() => f.model.requests.length === 1);

  setClock(f, DUE_MS);
  const serve = startServe(f);
  await waitStarted(serve);
  await waitFor(() => f.model.requests.length === 2);

  const code = await stopServe(serve);
  assert.equal(code, 0);
  const owned = await settle(f, "owned-child");
  assert.equal(owned.outcome, "unknown");

  // The independent manual supervisor and its child are untouched.
  assert.equal(manual.exitCode, null);
  assert.equal(manual.signalCode, null);
  manualGate.release();
  assert.equal(await manualDone, 0, "the independent manual run must complete normally");
  assert.equal((occurrence(f, "owned-child")).status, "settled");
});

test("ordinary Print startup neither installs, starts, nor probes the Trigger", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addJob(f, "quiet-job");
  f.model.jobs.push(gate(textResponse("PRINT-ONLY")));
  const result = await runCliAsync(f, ["-p", "hello"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(join(f.jobs, "trigger.lock")), false);
  assert.equal(existsSync(join(f.jobs, "admission.lock")), false);
  assert.equal(existsSync(schedulePath(f, "quiet-job")), false);
  assert.equal(f.model.requests.length, 1);
});

test("list and show report real Trigger liveness; scheduled children receive no secrets", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  const held = gate(textResponse("SECRET-FREE"), true);
  f.model.jobs.push(held);
  addJob(f, "live-job");

  let shown = runCli(f, ["automation", "list"]);
  assert.equal(JSON.parse(shown.stdout).jobs[0].triggerRunning, false);

  setClock(f, DUE_MS);
  const serve = startServe(f, { MEM0_API_KEY: SECRET_SENTINEL, FEISHU_REMOTE_APP_SECRET: SECRET_SENTINEL });
  await waitStarted(serve);
  await waitFor(() => f.model.requests.length === 1);
  shown = runCli(f, ["automation", "list"]);
  const summary = JSON.parse(shown.stdout).jobs[0];
  assert.equal(summary.triggerRunning, true);
  assert.equal(typeof summary.triggerPid, "number");
  assert.equal(summary.triggerPid, serve.child.pid);

  held.release();
  await settle(f, "live-job");
  await stopServe(serve);
  const inspected = runCli(f, ["automation", "show", "live-job"]);
  const diagnostics = [serve.stderr, shown.stdout, shown.stderr, inspected.stdout, inspected.stderr, ...f.model.requests].join("\n");
  assert.doesNotMatch(diagnostics, new RegExp(SECRET_SENTINEL));
  function scanFiles(root: string): void {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue; // compatibility Home links back to the real agent Home
      const path = join(root, entry.name);
      if (entry.isDirectory()) scanFiles(path);
      else if (entry.isFile()) assert.doesNotMatch(readFileSync(path, "utf8"), new RegExp(SECRET_SENTINEL), path);
    }
  }
  scanFiles(f.jobs);
  scanFiles(join(f.home, ".feishu-agent"));
});

test("an expired one-shot stays manually runnable with an honest receipt and keeps its expired status", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addJob(f, "expired-manual");
  setClock(f, DUE_MS + 3 * 60 * MIN);
  const serve = startServe(f);
  await waitStarted(serve);
  assert.equal((await settle(f, "expired-manual")).outcome, "expired");
  await stopServe(serve);

  f.model.jobs.push(gate(textResponse("MANUAL-ANYWAY")));
  setClock(f, DUE_MS + 4 * 60 * MIN);
  const run = await runCliAsync(f, ["automation", "run", "expired-manual"]);
  assert.equal(run.code, 0, run.stderr);
  const receipt = JSON.parse(run.stdout);
  assert.equal(receipt.outcome, "completed");
  assert.match(receipt.scheduleNotice, /expired|separate attempt/i);

  const show = JSON.parse(runCli(f, ["automation", "show", "expired-manual"]).stdout);
  assert.equal(show.scheduleOccurrence.outcome, "expired");
  assert.equal(show.latestRun.trigger, "manual");
});

test("a missing dispatch ledger after a started run is diagnosed, never treated as a new occurrence", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addJob(f, "lost-ledger");
  f.model.jobs.push(gate(textResponse("CONSUMED")));
  setClock(f, DUE_MS);
  const serving = startServe(f);
  await waitStarted(serving);
  await settle(f, "lost-ledger");
  await stopServe(serving);
  unlinkSync(schedulePath(f, "lost-ledger")); // damaged state, not an authorized re-arm
  const show = JSON.parse(runCli(f, ["automation", "show", "lost-ledger"]).stdout);
  assert.equal(show.scheduledState, "unknown");
  assert.equal(show.nextDueAt, null);
  const restarted = startServe(f);
  await waitStarted(restarted);
  try {
    const status = await runCliAsync(f, ["automation", "show", "lost-ledger"]);
    assert.match(status.stderr, /missing.*preserved|preserved.*missing/i);
    assert.equal(f.model.requests.length, 1);
  } finally {
    await stopServe(restarted);
  }
});

test("crash at the child-ready checkpoint consumes the occurrence without running any model", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addJob(f, "pre-admission-crash");
  const checkpoint = join(f.root, "child-ready");
  const preload = join(f.root, "checkpoint.mjs");
  writeFileSync(preload, `import { writeFileSync } from 'node:fs';
if (process.send && process.argv.includes('-p')) {
  const send = process.send.bind(process);
  process.send = function(message, ...args) {
    if (message?.type === 'automation-ready') {
      writeFileSync(${JSON.stringify(checkpoint)}, String(process.pid));
      return true; // deterministic checkpoint before releasing any Print work
    }
    return send(message, ...args);
  };
}
`);
  setClock(f, DUE_MS);
  const serving = startServe(f, { NODE_OPTIONS: `--import=${preload}` });
  await waitStarted(serving);
  try {
    await waitFor(() => existsSync(checkpoint));
    assert.equal(f.model.requests.length, 0);
    await stopServe(serving, "SIGKILL");
    const restarted = startServe(f);
    await waitStarted(restarted);
    try {
      assert.equal((await settle(f, "pre-admission-crash")).outcome, "unknown");
      assert.equal(f.model.requests.length, 0);
    } finally {
      await stopServe(restarted);
    }
  } finally {
    if (serving.child.exitCode === null && serving.child.signalCode === null) await stopServe(serving);
  }
});

test("manual execution cannot overlap a scheduled run and cannot re-arm a completed one-shot", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addJob(f, "manual-after-schedule");
  const held = gate(textResponse("SCHEDULED-DONE"), true);
  f.model.jobs.push(held);
  setClock(f, DUE_MS);
  const serving = startServe(f);
  await waitStarted(serving);
  try {
    await waitFor(() => f.model.requests.length === 1);
    const refused = await runCliAsync(f, ["automation", "run", "manual-after-schedule"]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /already running/);
    assert.equal(f.model.requests.length, 1);
    held.release();
    const consumed = await settle(f, "manual-after-schedule");
    f.model.jobs.push(gate(textResponse("MANUAL-DONE")));
    const manual = await runCliAsync(f, ["automation", "run", "manual-after-schedule"]);
    assert.equal(manual.code, 0, manual.stderr);
    assert.match(JSON.parse(manual.stdout).scheduleNotice, /already settled as completed/);
    assert.match(JSON.parse(manual.stdout).scheduleNotice, /repeat.*effects/);
    const show = JSON.parse((await runCliAsync(f, ["automation", "show", "manual-after-schedule"])).stdout);
    assert.deepEqual(show.scheduleOccurrence, consumed);
    assert.equal(show.nextDueAt, null);
    assert.equal(show.recentRuns.length, 2);
    assert.equal(f.model.requests.length, 2);
  } finally {
    held.release();
    await stopServe(serving);
  }
});

test("supervised Print waits for admission and exits without model work if its parent disconnects", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  for (const admit of [false, true]) {
    const child = spawn(process.execPath, [cli, "-p", "supervised admission probe"], {
      cwd: f.root,
      env: baseEnv(f, { FEISHU_UNATTENDED: "1", FEISHU_AUTOMATION_ADMISSION: "1" }),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout?.resume();
    let diagnostics = "";
    child.stderr?.on("data", (chunk) => diagnostics += chunk);
    const ended = new Promise<number | null>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`Print admission=${admit} did not close: exit=${child.exitCode}, signal=${child.signalCode}, connected=${child.connected}; ${diagnostics}`)), 10000);
      child.once("exit", (code) => { clearTimeout(deadline); resolve(code); });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("supervised Print did not request admission")), 5000);
        child.once("message", (message) => {
          clearTimeout(deadline);
          assert.deepEqual(message, { type: "automation-ready" });
          resolve();
        });
      });
      assert.equal(f.model.requests.length, 0, "Print ran before admission");
      if (admit) {
        f.model.jobs.push(gate(textResponse("ADMITTED")));
        child.send({ type: "automation-admit" });
        assert.equal(await ended, 0);
        assert.equal(f.model.requests.length, 1);
      } else {
        child.disconnect();
        assert.equal(await ended, 1);
        assert.equal(f.model.requests.length, 0);
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }
});

test("scheduled partial effects followed by guarded failure are not replayed after restart", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  const marker = join(f.root, "fake-effect.log");
  writeFileSync(join(f.bin, "lark-cli"), `#!/bin/sh\ncase "$1 $2" in\n  "profile list") printf '%s' '${profileJson()}' ;;\n  "im send") echo effect >> '${marker}'; echo sent ;;\n  *) exit 2 ;;\nesac\n`, { mode: 0o755 });
  addJob(f, "partial-job", [], "Summarize the documents and report the result.");
  const tool = (command: string, id: string) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
  f.model.jobs.push(
    gate(tool("lark-cli im send --as bot", "effect-40")),
    gate(tool("lark-cli doc delete doc-1 --as user --yes", "blocked-40")),
  );
  setClock(f, DUE_MS);
  const serving = startServe(f);
  await waitStarted(serving);
  try {
    await waitFor(() => /settled as failed/.test(serving.stderr));
    assert.equal(readFileSync(marker, "utf8"), "effect\n");
    const show = JSON.parse(runCli(f, ["automation", "show", "partial-job"]).stdout);
    assert.equal(show.latestRun.outcome, "failed");
    assert.equal(show.scheduleOccurrence.outcome, "failed");
  } finally {
    await stopServe(serving);
  }
  const requestCount = f.model.requests.length;
  const restarted = startServe(f);
  await waitStarted(restarted);
  try {
    const show = JSON.parse(runCli(f, ["automation", "show", "partial-job"]).stdout);
    assert.equal(show.nextDueAt, null);
    assert.equal(show.recentRuns.length, 1);
    assert.equal(f.model.requests.length, requestCount);
    assert.equal(readFileSync(marker, "utf8"), "effect\n");
  } finally {
    await stopServe(restarted);
  }
});

test("an unexpected child signal after a simulated effect is unknown and never replayed", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  const marker = join(f.root, "signal-effect.log");
  writeFileSync(join(f.bin, "lark-cli"), `#!/bin/sh\ncase "$1 $2" in\n  "profile list") printf '%s' '${profileJson()}' ;;\n  "im send") echo effect >> '${marker}'; echo sent ;;\n  *) exit 2 ;;\nesac\n`, { mode: 0o755 });
  addJob(f, "signal-job", [], "Report a summary to the fixed conversation as bot.");
  const call = { index: 0, id: "signal-effect", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "lark-cli im send --as bot" }) } };
  const tool = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
  const held = gate(textResponse("AFTER-EFFECT"), true);
  f.model.jobs.push(gate(tool), held);
  setClock(f, DUE_MS);
  const serving = startServe(f);
  await waitStarted(serving);
  try {
    await waitFor(() => f.model.requests.length === 2);
    assert.equal(readFileSync(marker, "utf8"), "effect\n");
    const running = JSON.parse((await runCliAsync(f, ["automation", "show", "signal-job"])).stdout);
    const childPid = running.scheduleOccurrence.childPid;
    assert.equal(typeof childPid, "number");
    process.kill(childPid, "SIGKILL"); // the real checkpointed child, not its supervisor
    const settled = await settle(f, "signal-job");
    assert.equal(settled.outcome, "unknown");
    const show = JSON.parse((await runCliAsync(f, ["automation", "show", "signal-job"])).stdout);
    assert.equal(show.latestRun.outcome, "unknown");
    assert.equal(show.latestRun.exitCode, null);
    assert.notEqual(show.latestRun.endedAt, null);
  } finally {
    held.release();
    await stopServe(serving);
  }
  const restarted = startServe(f);
  await waitStarted(restarted);
  try {
    const show = JSON.parse((await runCliAsync(f, ["automation", "show", "signal-job"])).stdout);
    assert.equal(show.nextDueAt, null);
    assert.equal(show.recentRuns.length, 1);
    assert.equal(f.model.requests.length, 2);
    assert.equal(readFileSync(marker, "utf8"), "effect\n");
  } finally {
    await stopServe(restarted);
  }
});

test("a successful manual attempt keeps its receipt when scheduled state is corrupt", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addJob(f, "manual-corrupt-ledger");
  for (const evidence of ["{broken", '{"version":99}']) {
    writeFileSync(schedulePath(f, "manual-corrupt-ledger"), evidence);
    f.model.jobs.push(gate(textResponse("MANUAL-COMPLETED")));
    const result = await runCliAsync(f, ["automation", "run", "manual-corrupt-ledger"]);
    assert.equal(result.code, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.outcome, "completed");
    assert.equal(receipt.exitCode, 0);
    assert.match(receipt.scheduleNotice, /unavailable|cannot determine/i);
    assert.match(result.stderr, /preserved/);
    assert.equal(readFileSync(schedulePath(f, "manual-corrupt-ledger"), "utf8"), evidence);
    const show = JSON.parse((await runCliAsync(f, ["automation", "show", "manual-corrupt-ledger"])).stdout);
    assert.equal(show.latestRun.runId, receipt.runId);
    assert.equal(show.latestRun.outcome, "completed");
    assert.equal(show.scheduledState, "unknown");
  }
  assert.equal(f.model.requests.length, 2, "each explicit manual request starts exactly one attempt");
});

test("invalid job shape is diagnosed and preserved instead of being scheduled", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addJob(f, "invalid-job");
  const path = join(f.jobs, "jobs", "invalid-job", "job.json");
  const original = JSON.parse(readFileSync(path, "utf8"));
  for (const value of [null, { ...original, task: "" }, { ...original, schedule: { ...original.schedule, dueMs: "yesterday" } }, { ...original, name: "../escape" }]) {
    const evidence = JSON.stringify(value);
    writeFileSync(path, evidence);
    const show = runCli(f, ["automation", "show", "invalid-job"]);
    assert.equal(show.code, 1);
    assert.match(show.stderr, /preserved/);
    assert.equal(readFileSync(path, "utf8"), evidence);
    const list = runCli(f, ["automation", "list"]);
    assert.deepEqual(JSON.parse(list.stdout).jobs, []);
  }
});

test("corrupt scheduled state is preserved without preventing healthy jobs from firing", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addJob(f, "bad-state");
  addJob(f, "healthy-state");
  writeFileSync(schedulePath(f, "bad-state"), "{broken");
  f.model.jobs.push(gate(textResponse("HEALTHY-FIRED")));
  setClock(f, DUE_MS);
  const serving = startServe(f);
  await waitStarted(serving);
  try {
    await waitFor(() => f.model.requests.length === 1);
    await settle(f, "healthy-state");
    assert.match(serving.stderr, /preserved/);
    assert.equal(readFileSync(schedulePath(f, "bad-state"), "utf8"), "{broken");
    assert.equal(JSON.parse(runCli(f, ["automation", "show", "bad-state"]).stdout).scheduledState, "unknown");
  } finally {
    if (serving.child.exitCode === null && serving.child.signalCode === null) await stopServe(serving);
  }
});

test("scheduled timeout uses the shared runner and remains consumed across restart", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addJob(f, "timeout-job", ["--timeout", "1m"]);
  const held = gate(textResponse("TOO-LATE"), true);
  f.model.jobs.push(held);
  setClock(f, DUE_MS);
  const serving = startServe(f);
  await waitStarted(serving);
  try {
    await waitFor(() => f.model.requests.length === 1);
    const running = JSON.parse(runCli(f, ["automation", "show", "timeout-job"]).stdout);
    assert.equal(running.latestRun.outcome, "unknown");
    assert.equal(running.latestRun.endedAt, null);
    setClock(f, DUE_MS + MIN);
    await waitFor(() => /settled as timeout/.test(serving.stderr));
    const shown = JSON.parse(runCli(f, ["automation", "show", "timeout-job"]).stdout);
    assert.equal(shown.latestRun.outcome, "timeout");
    assert.equal(shown.scheduleOccurrence.outcome, "timeout");
  } finally {
    held.release();
    await stopServe(serving);
  }
  setClock(f, DUE_MS);
  const restarted = startServe(f);
  await waitStarted(restarted);
  try {
    const shown = JSON.parse(runCli(f, ["automation", "show", "timeout-job"]).stdout);
    assert.equal(shown.scheduledState, "consumed");
    assert.equal(shown.recentRuns.length, 1);
    assert.equal(f.model.requests.length, 1);
  } finally {
    await stopServe(restarted);
  }
});

test("a corrupt or unsupported Trigger lock is preserved, never guessed stale", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addJob(f, "future-job");
  for (const evidence of ["{unfinished", '{"version":99,"pid":123}', '{"pid":0}', 'null']) {
    const lock = join(f.jobs, "trigger.lock");
    writeFileSync(lock, evidence);
    const result = spawnSync(process.execPath, [cli, "automation", "serve"], {
      encoding: "utf8", cwd: f.root, env: baseEnv(f), timeout: 3000, killSignal: "SIGKILL",
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /preserved/i);
    assert.doesNotMatch(result.stderr, /Trigger started/);
    assert.equal(readFileSync(lock, "utf8"), evidence);
  }
  const unrelated = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  writeFileSync(join(f.jobs, "trigger.lock"), unrelated);
  const blocked = runCli(f, ["automation", "serve"]);
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.stderr, /already running/);
  assert.equal(readFileSync(join(f.jobs, "trigger.lock"), "utf8"), unrelated);
});

test("inspection is read-only and preserves malformed schedule evidence without claiming eligibility", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addJob(f, "inspection-job");
  const standing = join(f.jobs, "AGENTS.md");
  unlinkSync(standing);

  const inspected = runCli(f, ["automation", "show", "inspection-job"]);
  assert.equal(inspected.code, 0, inspected.stderr);
  assert.equal(existsSync(standing), false, "show must not seed missing workspace instructions");
  assert.match(JSON.parse(inspected.stdout).scheduleNotice, /remains eligible/);

  for (const invalid of ["{broken", '{"version":99}', '{"version":1,"name":"inspection-job","occurrences":[]}']) {
    writeFileSync(schedulePath(f, "inspection-job"), invalid);
    const result = runCli(f, ["automation", "show", "inspection-job"]);
    assert.equal(result.code, 0, result.stderr);
    const shown = JSON.parse(result.stdout);
    assert.equal(shown.scheduledState, "unknown");
    assert.equal(shown.nextDueAt, null);
    assert.match(shown.scheduleNotice, /cannot determine|unavailable/i);
    assert.match(result.stderr, /preserved/i);
    assert.equal(readFileSync(schedulePath(f, "inspection-job"), "utf8"), invalid);
    assert.equal(existsSync(standing), false);
  }
});

test("creation while the foreground Trigger is live gives an honest receipt", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  const serving = startServe(f);
  await waitStarted(serving);
  try {
    const result = spawnSync(process.execPath, [cli, "automation", "add", "--name", "live-receipt", "--at", "2030-06-01T09:00", "--prompt-stdin", "--yes"], {
      encoding: "utf8", cwd: f.root, env: baseEnv(f), input: "self-contained task\n",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).triggerRunning, true);
    assert.doesNotMatch(result.stderr, /Trigger is not running|Start `feishu automation serve`/);
    assert.equal(JSON.parse(result.stdout).nextDueAt, new Date(DUE_MS).toISOString());
  } finally {
    await stopServe(serving);
  }
});

test("--catch-up changes the per-job lateness window; --no-catch-up and bad durations are rejected", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addJob(f, "short-window", ["--catch-up", "30m"]);
  const show = JSON.parse(runCli(f, ["automation", "show", "short-window"]).stdout);
  assert.equal(show.schedule.latenessMinutes, 30);

  const badDuration = spawnSync(process.execPath, [cli, "automation", "add", "--name", "bad", "--at", "2030-06-01T09:00", "--prompt-stdin", "--catch-up", "30s", "--yes"], {
    encoding: "utf8", cwd: f.root, input: "t\n", env: baseEnv(f),
  });
  assert.notEqual(badDuration.status, 0);
  assert.match(badDuration.stderr, /positive duration/i);

  const conflicting = spawnSync(process.execPath, [cli, "automation", "add", "--name", "bad2", "--at", "2030-06-01T09:00", "--prompt-stdin", "--catch-up", "1h", "--no-catch-up", "--yes"], {
    encoding: "utf8", cwd: f.root, input: "t\n", env: baseEnv(f),
  });
  assert.notEqual(conflicting.status, 0);
  assert.match(conflicting.stderr, /catch-up/i);

  f.model.jobs.push(gate(textResponse("WINDOW")));
  setClock(f, DUE_MS + 31 * MIN);
  const serve = startServe(f);
  await waitStarted(serve);
  assert.equal((await settle(f, "short-window")).outcome, "expired");
  assert.equal(f.model.requests.length, 0);
  await stopServe(serve);
});

// ---------------------------------------------------------------------------
// #41: cron recurrence, fixed intervals, catch-up, DST, overlap, failure
// ---------------------------------------------------------------------------

function addCron(f: Fixture, name: string, expr: string, extraArgs: string[] = [], task = "Recurring task."): void {
  const result = spawnSync(process.execPath, [cli, "automation", "add", "--name", name, "--cron", expr, "--prompt-stdin", ...extraArgs, "--yes"], {
    encoding: "utf8", cwd: f.root, input: `${task}\n`, env: baseEnv(f),
  });
  assert.equal(result.status, 0, result.stderr);
}

function addEvery(f: Fixture, name: string, duration: string, extraArgs: string[] = [], task = "Interval task."): void {
  const result = spawnSync(process.execPath, [cli, "automation", "add", "--name", name, "--every", duration, "--prompt-stdin", ...extraArgs, "--yes"], {
    encoding: "utf8", cwd: f.root, input: `${task}\n`, env: baseEnv(f),
  });
  assert.equal(result.status, 0, result.stderr);
}

function setClockAndWait(f: Fixture, ms: number, predicate: () => boolean): Promise<void> {
  setClock(f, ms);
  return waitFor(predicate);
}

async function settledOccurrence(f: Fixture, name: string, dueMs: number): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await runCliAsync(f, ["automation", "show", name]);
    assert.equal(result.code, 0, result.stderr);
    const shown = JSON.parse(result.stdout);
    const entries: Array<Record<string, unknown>> = shown.scheduleOccurrences ?? [];
    const match = entries.find((entry) => entry.status === "settled" && entry.dueMs === dueMs);
    if (match) return match;
    // Backwards compatibility for one-job summaries that expose only the latest.
    const latest = shown.scheduleOccurrence;
    if (latest?.status === "settled" && latest.dueMs === dueMs) return latest;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`settled occurrence ${new Date(dueMs).toISOString()} for ${name} was not reported`);
}

test("a failed recurring occurrence does not stop later normal recurrence; rollback does not replay settled occurrences", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  // Same fake lark-cli and tool pattern as the slice-2 guarded-failure test.
  const marker = join(f.root, "cron-fail-effect.log");
  writeFileSync(join(f.bin, "lark-cli"), `#!/bin/sh
case "$1 $2" in
  "profile list") printf '%s' '${profileJson()}' ;;
  "im send") echo effect >> '${marker}'; echo sent ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
  setClock(f, DUE_MS);
  addCron(f, "every-minute", "* * * * *", ["--timeout", "1h"], "Summarize the documents and report the result.");
  const tool = (command: string, id: string): string => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
  f.model.jobs.push(
    gate(tool("lark-cli im send --as bot", "cron-effect")),
    gate(tool("lark-cli doc delete doc-1 --as user --yes", "cron-blocked")),
    gate(textResponse("MINUTE-TWO-OK")),
    gate(textResponse("MINUTE-THREE-OK")),
  );

  const serve = startServe(f);
  await waitStarted(serve);
  const t0 = DUE_MS;
  await waitFor(() => f.model.requests.length === 2);
  await waitFor(() => /settled as failed/.test(serve.stderr));
  const first = await settledOccurrence(f, "every-minute", t0);
  assert.equal(first.outcome, "failed");
  assert.equal(readFileSync(marker, "utf8"), "effect\n");

  setClock(f, t0 + MIN);
  await waitFor(() => f.model.requests.length === 3, 400);
  const second = await settledOccurrence(f, "every-minute", t0 + MIN);
  assert.equal(second.outcome, "completed");

  // Clock rollback never re-runs a settled occurrence.
  setClock(f, t0 - 5 * MIN);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(f.model.requests.length, 3, "a settled occurrence was redispatched after rollback");
  setClock(f, t0 + 3 * MIN); // advance two whole minutes past the latest run
  await waitFor(() => f.model.requests.length === 4, 400);
  await settledOccurrence(f, "every-minute", t0 + 3 * MIN);
  const shown = JSON.parse(runCli(f, ["automation", "show", "every-minute"]).stdout);
  assert.equal(shown.recentRuns.length, 3);
  assert.deepEqual(shown.recentRuns.map((r: { trigger: string }) => r.trigger), ["scheduled", "scheduled", "scheduled"]);
  await stopServe(serve);
});

test("cron does not fire before the due minute", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  setClock(f, DUE_MS - 1_000); // enabled inside the minute before t0
  addCron(f, "early", "0 9 * * *", ["--timeout", "1h"]); // 09:00 SH = t0
  const serve = startServe(f);
  await waitStarted(serve);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(f.model.requests.length, 0, "cron fired before its due minute");
  assert.equal(JSON.parse(runCli(f, ["automation", "show", "early"]).stdout).scheduledState, "future");
  await stopServe(serve);
});

test("recovery coalesces many missed cron minutes to the latest eligible one only (default 2h catch-up)", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  setClock(f, DUE_MS - 1_000);
  addCron(f, "downtime", "* * * * *");
  // Trigger starts after a 90-minute downtime: only the latest missed minute catches up.
  f.model.jobs.push(gate(textResponse("COALESCED-LATEST")));
  setClock(f, DUE_MS + 90 * MIN);
  const serve = startServe(f);
  await waitStarted(serve);
  await waitFor(() => f.model.requests.length === 1);
  const occ = await settle(f, "downtime");
  assert.equal(occ.dueMs, DUE_MS + 90 * MIN);
  assert.equal(occ.outcome, "completed");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(f.model.requests.length, 1, "missed backlog was replayed");
  await stopServe(serve);
});

test("adjustable catch-up windows change the cutoff; out-of-window occurrences are skipped without a run", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  // Two jobs present before the due minute: a 2h window and a 5m window.
  addCron(f, "stale", "0 9 * * *");
  addCron(f, "short", "0 9 * * *", ["--catch-up", "5m"]);
  f.model.jobs.push(gate(textResponse("STALE-CATCHUP")));

  // 6 minutes late: stale (2h) fires; short (5m) is already out of window.
  setClock(f, DUE_MS + 6 * MIN);
  const serve = startServe(f);
  await waitStarted(serve);
  await waitFor(() => f.model.requests.length === 1);
  const stale = await settle(f, "stale");
  assert.equal(stale.outcome, "completed");
  const shortSkipped = await settledOccurrence(f, "short", DUE_MS);
  assert.equal(shortSkipped.outcome, "lateness-skipped");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(f.model.requests.length, 1, "an out-of-window recurring occurrence was dispatched");
  await stopServe(serve);
});

test("catch-up disabled: the due minute still fires but older missed minutes never replay", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addCron(f, "strict", "0 9 * * *", ["--no-catch-up", "--timeout", "1h"]); // single daily fire at DUE_MS
  setClock(f, DUE_MS + 2 * MIN); // already two minutes past the only occurrence
  const serve = startServe(f);
  await waitStarted(serve);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(f.model.requests.length, 0, "an older due minute replayed with catch-up disabled");
  const skipped = await settledOccurrence(f, "strict", DUE_MS);
  assert.equal(skipped.outcome, "lateness-skipped");
  await stopServe(serve);
});

test("catch-up disabled: a fresh occurrence reached on its own minute fires normally", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addCron(f, "strict-fresh", "0 9 * * *", ["--no-catch-up", "--timeout", "1h"]);
  setClock(f, DUE_MS - 1_000); // enabled one second before the due minute
  const serve = startServe(f);
  await waitStarted(serve);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(f.model.requests.length, 0, "fired before its due minute");
  f.model.jobs.push(gate(textResponse("ON-THE-MINUTE")));
  setClock(f, DUE_MS);
  await waitFor(() => f.model.requests.length === 1);
  await settledOccurrence(f, "strict-fresh", DUE_MS);
  await stopServe(serve);
});

test("fixed intervals anchor at first enablement, survive run duration and restart, and are distinct from cron steps", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  setClock(f, DUE_MS - 90 * MIN);
  addEvery(f, "ninety", "90m", ["--timeout", "1h"]);
  // The anchor is the enablement instant under the same controlled clock.
  const created = JSON.parse(runCli(f, ["automation", "show", "ninety"]).stdout);
  const anchor = Date.parse(created.schedule.anchoredAt);
  assert.ok(Math.abs(anchor - (DUE_MS - 90 * MIN)) < 5_000);
  assert.equal(Date.parse(created.nextDueAt), anchor + 90 * MIN);

  f.model.jobs.push(gate(textResponse("FIRST-INTERVAL")));
  setClock(f, anchor + 90 * MIN);
  const serve = startServe(f);
  await waitStarted(serve);
  await waitFor(() => f.model.requests.length === 1);
  await settledOccurrence(f, "ninety", anchor + 90 * MIN);

  // Run duration does not shift the beat: even if completion is observed much
  // later, the next grid point stays anchor + 180m.
  f.model.jobs.push(gate(textResponse("SECOND-INTERVAL")));
  setClock(f, anchor + 180 * MIN);
  await waitFor(() => f.model.requests.length === 2);
  await settledOccurrence(f, "ninety", anchor + 180 * MIN);
  await stopServe(serve);

  // Restart keeps the same anchor and catches up only the latest grid point.
  f.model.jobs.push(gate(textResponse("AFTER-RESTART")));
  setClock(f, anchor + 360 * MIN); // four grid points later
  const restarted = startServe(f);
  await waitStarted(restarted);
  await waitFor(() => f.model.requests.length === 3);
  await settledOccurrence(f, "ninety", anchor + 360 * MIN);
  assert.equal(f.model.requests.length, 3, "interval backlog was replayed");
  await stopServe(restarted);
});

test("a recurring occurrence during an active same-job run is overlap-skipped without queuing", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addCron(f, "slow", "* * * * *", ["--timeout", "1h"], "Hold the model response open.");
  const held = gate(textResponse("SLOW-HELD"), true);
  f.model.jobs.push(held);
  setClock(f, DUE_MS - 30_000);
  const serve = startServe(f);
  await waitStarted(serve);
  setClock(f, DUE_MS);
  await waitFor(() => f.model.requests.length === 1);

  // Two more minutes pass while the first run is still active.
  setClock(f, DUE_MS + MIN);
  const skipped1 = await settledOccurrence(f, "slow", DUE_MS + MIN);
  assert.equal(skipped1.outcome, "overlap-skipped");
  setClock(f, DUE_MS + 2 * MIN);
  const skipped2 = await settledOccurrence(f, "slow", DUE_MS + 2 * MIN);
  assert.equal(skipped2.outcome, "overlap-skipped");
  assert.equal(f.model.requests.length, 1, "an overlap-skipped occurrence started a child");

  // After completion the skipped minutes are not queued; only a genuinely new
  // minute fires.
  held.release();
  await settledOccurrence(f, "slow", DUE_MS);
  f.model.jobs.push(gate(textResponse("LATER-MINUTE")));
  setClock(f, DUE_MS + 3 * MIN);
  await waitFor(() => f.model.requests.length === 2);
  await settledOccurrence(f, "slow", DUE_MS + 3 * MIN);
  await stopServe(serve);
});

test("recurring jobs share the two-run capacity and keep original waiting deadlines", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addCron(f, "cap-a", "* * * * *", ["--timeout", "1h"]);
  addCron(f, "cap-b", "* * * * *", ["--timeout", "1h"]);
  // cap-c has no catch-up: its 09:00 minute is lost while the other two hold capacity.
  addCron(f, "cap-c", "0 9 * * *", ["--no-catch-up", "--timeout", "1h"]);
  const heldA = gate(textResponse("CAP-A"), true);
  const heldB = gate(textResponse("CAP-B"), true);
  f.model.jobs.push(heldA, heldB);
  setClock(f, DUE_MS - 1_000);
  const serve = startServe(f);
  await waitStarted(serve);
  setClock(f, DUE_MS);
  await waitFor(() => f.model.requests.length === 2);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(f.model.requests.length, 2, "a third recurring job exceeded capacity");

  // cap-c's 09:00 minute ages out while capacity is full: skipped, no run.
  setClock(f, DUE_MS + MIN);
  const skippedC = await settledOccurrence(f, "cap-c", DUE_MS);
  assert.equal(skippedC.outcome, "lateness-skipped");
  assert.equal(f.model.requests.length, 2);

  // Releasing both slots frees the minute jobs; a skipped occurrence is never queued.
  f.model.jobs.push(gate(textResponse("CAP-NEXT-A")), gate(textResponse("CAP-NEXT-B")));
  heldA.release();
  heldB.release();
  await new Promise((r) => setTimeout(r, 300)); // both held runs complete
  setClock(f, DUE_MS + 2 * MIN); // a genuinely new minute after the releases
  await waitFor(() => f.model.requests.length === 4, 400);
  await stopServe(serve);
});

test("DST: nonexistent New York cron minutes are skipped and the repeated fall-back minute fires once", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  // 02:30 every night: absent on 2025-03-09 (spring gap), repeated on 2025-11-02.
  setClock(f, Date.parse("2025-03-08T12:00:00Z")); // created the day before the gap
  addCron(f, "half-two", "30 2 * * *", ["--tz", "America/New_York", "--timeout", "1h"]);

  const gapDay = Date.parse("2025-03-09T04:00:00Z"); // before the 02:00 local spring gap
  setClock(f, gapDay);
  const serve = startServe(f);
  await waitStarted(serve);
  setClock(f, Date.parse("2025-03-09T08:00:00Z")); // 04:00 local, well past the missing 02:30
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(f.model.requests.length, 0, "a nonexistent DST-gap calendar minute was dispatched");
  // The next occurrence is the following day 02:30 -04:00 = 06:30Z.
  const shown = JSON.parse(runCli(f, ["automation", "show", "half-two"]).stdout);
  assert.equal(shown.nextDueAt, "2025-03-10T06:30:00.000Z");

  f.model.jobs.push(gate(textResponse("POST-GAP")));
  setClock(f, Date.parse("2025-03-10T06:30:00Z"));
  await waitFor(() => f.model.requests.length === 1);
  await stopServe(serve);

  // Fall-back day: 01:30 repeats but fires exactly once.
  setClock(f, Date.parse("2025-11-01T12:00:00Z")); // created the day before the fold
  addCron(f, "fold", "30 1 * * *", ["--tz", "America/New_York", "--timeout", "1h"]);
  f.model.jobs.push(gate(textResponse("FOLD-ONCE")));
  setClock(f, Date.parse("2025-11-02T04:00:00Z")); // just before the first 01:30 (-04:00 = 05:30Z)
  const serving = startServe(f);
  await waitStarted(serving);
  setClock(f, Date.parse("2025-11-02T07:00:00Z")); // past both readings (05:30 and 06:30)
  await waitFor(() => f.model.requests.length === 2);
  const fold = await settle(f, "fold");
  assert.equal(fold.dueMs, Date.parse("2025-11-02T05:30:00Z"));
  assert.equal(fold.outcome, "completed");
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(f.model.requests.length, 2, "the repeated DST-fold minute fired twice");
  await stopServe(serving);
});

test("manual execution of a recurring job neither consumes nor shifts its schedule", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  setClock(f, DUE_MS - 30 * MIN);
  addCron(f, "manual-shift", "0 9 * * *", ["--timeout", "1h"]); // 09:00 SH = DUE_MS
  f.model.jobs.push(gate(textResponse("MANUAL-REC-41")));
  const before = JSON.parse(runCli(f, ["automation", "show", "manual-shift"]).stdout).nextDueAt;
  assert.equal(before, new Date(DUE_MS).toISOString());
  const manual = await runCliAsync(f, ["automation", "run", "manual-shift"]);
  assert.equal(manual.code, 0, manual.stderr);
  assert.match(JSON.parse(manual.stdout).scheduleNotice, /neither consumes nor shifts/i);

  const after = JSON.parse(runCli(f, ["automation", "show", "manual-shift"]).stdout);
  assert.equal(after.nextDueAt, before, "manual run shifted recurrence");
  assert.equal(after.scheduleOccurrence, null, "a manual run created a scheduled occurrence");
  assert.equal(after.latestRun.trigger, "manual");

  // The scheduled minute still fires exactly once.
  f.model.jobs.push(gate(textResponse("SCHEDULED-REC-41")));
  setClock(f, DUE_MS);
  const serve = startServe(f);
  await waitStarted(serve);
  await waitFor(() => f.model.requests.length === 2);
  const scheduled = JSON.parse(runCli(f, ["automation", "show", "manual-shift"]).stdout);
  assert.equal(scheduled.recentRuns.filter((r: { trigger: string }) => r.trigger === "scheduled").length, 1);
  await stopServe(serve);
});

test("cron jobs persist their explicit timezone and ignore later host timezone changes", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addCron(f, "tokyo", "0 9 * * *", ["--tz", "Asia/Tokyo"]);
  const shown = JSON.parse(runCli(f, ["automation", "show", "tokyo"]).stdout);
  assert.equal(shown.schedule.timeZone, "Asia/Tokyo");
  // 09:00 Tokyo is 00:00 UTC regardless of the test host zone.
  const nextIso: string = shown.nextDueAt;
  assert.equal(new Date(nextIso).getUTCHours(), 0);
  assert.equal(new Date(nextIso).getUTCMinutes(), 0);
  // The rule text and zone are both visible in the confirmation receipt.
  const receipt = spawnSync(process.execPath, [cli, "automation", "add", "--name", "tokyo2", "--cron", "0 9 * * *", "--tz", "Asia/Tokyo", "--prompt-stdin", "--yes"], {
    encoding: "utf8", cwd: f.root, input: "t\n", env: baseEnv(f),
  });
  assert.equal(receipt.status, 0, receipt.stderr);
  assert.match(receipt.stderr, /Asia\/Tokyo/);
  assert.match(receipt.stderr, /cron "0 9 \* \* \*"/);
});
