import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  cli,
  DUE_MS,
  MIN,
  SECRET_SENTINEL,
  textResponse,
  gate,
  fixture,
  baseEnv,
  runCli,
  runCliAsync,
  addJob,
  setClock,
  waitStarted,
  stopServe,
  schedulePath,
  occurrence,
  profileJson,
  waitFor,
  settle,
  createTriggerHarness,
} from "./helpers/automation-trigger-fixture.js";

const { gateServers, orphanSupervisors, startServe } = createTriggerHarness();

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
