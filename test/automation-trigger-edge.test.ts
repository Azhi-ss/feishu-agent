import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  cli,
  DUE_MS,
  MIN,
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

  for (const invalid of ["{broken", '{"version":99}', '{"version":1,"name":"inspection-job","occurrences":[{"id":"oneshot:999","dueMs":"bad","status":"running"}]}']) {
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
