import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  addCron,
  addEvery,
  setClock,
  waitStarted,
  stopServe,
  waitFor,
  settle,
  settledOccurrence,
  createTriggerHarness,
} from "./helpers/automation-trigger-fixture.js";

const { gateServers, startServe } = createTriggerHarness();


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
  // Start on the target minute: starting earlier could admit an 08:59
  // catch-up run before the test advances the clock to 09:00.
  setClock(f, DUE_MS);
  const serve = startServe(f);
  await waitStarted(serve);
  await waitFor(() => f.model.requests.length === 2);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(f.model.requests.length, 2, "a third recurring job exceeded capacity");

  // cap-c's 09:00 minute ages out while capacity is full: skipped, no run.
  setClock(f, DUE_MS + MIN);
  const skippedC = await settledOccurrence(f, "cap-c", DUE_MS);
  assert.equal(skippedC.outcome, "lateness-skipped");
  assert.equal(f.model.requests.length, 2);
  assert.equal((await settledOccurrence(f, "cap-a", DUE_MS + MIN)).outcome, "overlap-skipped");
  assert.equal((await settledOccurrence(f, "cap-b", DUE_MS + MIN)).outcome, "overlap-skipped");

  // Releasing both slots frees the minute jobs; a skipped occurrence is never queued.
  f.model.jobs.push(gate(textResponse("CAP-NEXT-A")), gate(textResponse("CAP-NEXT-B")));
  heldA.release();
  heldB.release();
  assert.equal((await settledOccurrence(f, "cap-a", DUE_MS)).outcome, "completed");
  assert.equal((await settledOccurrence(f, "cap-b", DUE_MS)).outcome, "completed");
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

// ---------------------------------------------------------------------------
// #42: lifecycle management against the live foreground Trigger.
// ---------------------------------------------------------------------------
