import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hermeticEnv } from "./hermetic-env.js";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const cli = join(repoRoot, "dist/src/cli.js");

export const DUE_MS = Date.parse("2030-06-01T01:00:00.000Z"); // 09:00 Asia/Shanghai
export const MIN = 60_000;
export const SECRET_SENTINEL = "TRIGGER-SECRET-SENTINEL-40";

export const textResponse = (text: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;

export interface GateJob {
  response: string;
  gate: Promise<void>;
  release: () => void;
}

export function gate(response: string, hold = false): GateJob {
  let release = (): void => {};
  const gatePromise = new Promise<void>((done) => { release = done; });
  const job: GateJob = { response, gate: gatePromise, release };
  if (!hold) setImmediate(release);
  return job;
}

export interface GateServer {
  server: Server;
  port: number;
  jobs: GateJob[];
  requests: string[];
}

export function startGateServer(): Promise<GateServer> {
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

export interface Fixture {
  root: string;
  home: string;
  bin: string;
  jobs: string;
  model: GateServer;
  clockFile: string;
}

export function profileJson(): string {
  return JSON.stringify([{ name: "local-default", appId: "local-default", brand: "feishu", active: true, effective: true, effectiveSource: "config" }]);
}

export async function fixture(): Promise<Fixture> {
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

export interface Serve {
  child: ChildProcess;
  stderr: string;
}

export function createTriggerHarness() {
  const gateServers: Server[] = [];
  const spawnedServes: ChildProcess[] = [];
  const orphanSupervisors: ChildProcess[] = [];

  test.after(async () => {
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

  function startServe(f: Fixture, extra: NodeJS.ProcessEnv = {}): Serve {
    const child = spawn(process.execPath, [cli, "automation", "serve"], { cwd: f.root, env: baseEnv(f, extra), stdio: ["ignore", "pipe", "pipe"] });
    spawnedServes.push(child);
    child.stdout.resume();
    const serve: Serve = { child, stderr: "" };
    child.stderr.on("data", (chunk) => { serve.stderr += chunk; });
    child.stdout.on("data", () => {});
    return serve;
  }

  return { gateServers, spawnedServes, orphanSupervisors, startServe };
}

export function baseEnv(f: Fixture, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return hermeticEnv({
    HOME: f.home,
    PATH: `${f.bin}${delimiter}${process.env.PATH}`,
    PI_OFFLINE: "1",
    FEISHU_AUTOMATION_HOME: f.jobs,
    FEISHU_AUTOMATION_CLOCK_FILE: f.clockFile,
    ...extra,
  });
}

export function runCli(f: Fixture, args: string[], extra: NodeJS.ProcessEnv = {}): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: f.root, env: baseEnv(f, extra) });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function runCliAsync(f: Fixture, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
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

export function addJob(f: Fixture, name: string, extraArgs: string[] = [], task = "Self-contained scheduled task."): void {
  const result = spawnSync(process.execPath, [cli, "automation", "add", "--name", name, "--at", "2030-06-01T09:00", "--prompt-stdin", ...extraArgs, "--yes"], {
    encoding: "utf8", cwd: f.root, input: `${task}\n`, env: baseEnv(f),
  });
  assert.equal(result.status, 0, result.stderr);
}

export function addCron(f: Fixture, name: string, expr: string, extraArgs: string[] = [], task = "Recurring task."): void {
  const result = spawnSync(process.execPath, [cli, "automation", "add", "--name", name, "--cron", expr, "--prompt-stdin", ...extraArgs, "--yes"], {
    encoding: "utf8", cwd: f.root, input: `${task}\n`, env: baseEnv(f),
  });
  assert.equal(result.status, 0, result.stderr);
}

export function addEvery(f: Fixture, name: string, duration: string, extraArgs: string[] = [], task = "Interval task."): void {
  const result = spawnSync(process.execPath, [cli, "automation", "add", "--name", name, "--every", duration, "--prompt-stdin", ...extraArgs, "--yes"], {
    encoding: "utf8", cwd: f.root, input: `${task}\n`, env: baseEnv(f),
  });
  assert.equal(result.status, 0, result.stderr);
}

export function setClock(f: Fixture, ms: number): void {
  const staged = `${f.clockFile}.next`;
  writeFileSync(staged, JSON.stringify({ now: ms }));
  renameSync(staged, f.clockFile);
}

export function setClockAndWait(f: Fixture, ms: number, predicate: () => boolean): Promise<void> {
  setClock(f, ms);
  return waitFor(predicate);
}

export async function waitStarted(serve: Serve): Promise<void> {
  await waitFor(() => /Trigger started/i.test(serve.stderr));
}

export function stopServe(serve: Serve, signal: NodeJS.Signals = "SIGTERM"): Promise<number | null> {
  const child = serve.child;
  return new Promise((done) => {
    child.on("close", (code) => done(code));
    child.kill(signal);
  });
}

export function schedulePath(f: Fixture, name: string): string {
  return join(f.jobs, "jobs", name, "schedule.json");
}

export function occurrence(f: Fixture, name: string): Record<string, unknown> {
  const result = runCli(f, ["automation", "show", name]);
  assert.equal(result.code, 0, result.stderr);
  const occ = JSON.parse(result.stdout).scheduleOccurrence;
  assert(occ, "no scheduled occurrence was reported by the CLI");
  return occ;
}

export async function waitFor(predicate: () => boolean, attempts = 300): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
  throw new Error("condition was not met before timeout");
}

export async function settle(f: Fixture, name: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await runCliAsync(f, ["automation", "show", name]);
    assert.equal(result.code, 0, result.stderr);
    const occ = JSON.parse(result.stdout).scheduleOccurrence;
    if (occ?.status === "settled") return occ;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`CLI did not report a settled occurrence for ${name}`);
}

export async function settledOccurrence(f: Fixture, name: string, dueMs: number): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await runCliAsync(f, ["automation", "show", name]);
    assert.equal(result.code, 0, result.stderr);
    const shown = JSON.parse(result.stdout);
    const entries: Array<Record<string, unknown>> = shown.scheduleOccurrences ?? [];
    const match = entries.find((entry) => entry.status === "settled" && entry.dueMs === dueMs);
    if (match) return match;
    const latest = shown.scheduleOccurrence;
    if (latest?.status === "settled" && latest.dueMs === dueMs) return latest;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`settled occurrence ${new Date(dueMs).toISOString()} for ${name} was not reported`);
}
