import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  cli,
  DUE_MS,
  MIN,
  textResponse,
  gate,
  profileJson,
  fixture,
  baseEnv,
  runCli,
  runCliAsync,
  addJob,
  addCron,
  addEvery,
  setClock,
  waitStarted,
  stopServe,
  waitFor,
  occurrence,
  settle,
  settledOccurrence,
  schedulePath,
  createTriggerHarness,
} from "./helpers/automation-trigger-fixture.js";

const { gateServers, startServe } = createTriggerHarness();

test("pause stops new admission and discards pending occurrences across cron, interval, and one-shot; resume skips the paused period without replay", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  setClock(f, DUE_MS - 3 * MIN);
  addCron(f, "cron-job", "* * * * *", ["--timeout", "1h"]);
  addEvery(f, "interval-job", "1m", ["--timeout", "1h"]);
  addJob(f, "one-job", ["--catch-up", "120m"]);

  // Pause before any occurrence is due: no admission after two minutes tick.
  assert.equal(runCli(f, ["automation", "pause", "cron-job"]).code, 0);
  assert.equal(runCli(f, ["automation", "pause", "interval-job"]).code, 0);
  assert.equal(runCli(f, ["automation", "pause", "one-job"]).code, 0);
  const serve = startServe(f);
  await waitStarted(serve);
  setClock(f, DUE_MS);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(f.model.requests.length, 0, "a paused job admitted work");
  for (const name of ["cron-job", "interval-job"]) {
    const entry = await settledOccurrence(f, name, DUE_MS);
    assert.equal(entry.outcome, "lateness-skipped", name);
  }
  assert.equal((await settledOccurrence(f, "one-job", DUE_MS)).status, "settled"); // aged later below

  // Resume far past the window: the missed period is discarded, not replayed;
  // the next minute after resume is what fires (both kinds, once each).
  setClock(f, DUE_MS + 5 * MIN); // the paused one-shot's window elapsed; Trigger ages it
  for (let attempt = 0; attempt < 40; attempt++) {
    const entry = JSON.parse((await runCliAsync(f, ["automation", "show", "one-job"])).stdout).scheduleOccurrence;
    if (entry?.outcome === "expired") break;
    if (attempt === 39) throw new Error("paused one-shot was not expired after its window");
    await new Promise((r) => setTimeout(r, 50));
  }
  f.model.jobs.push(gate(textResponse("CRON-AFTER-RESUME")));
  f.model.jobs.push(gate(textResponse("INTERVAL-AFTER-RESUME")));
  const anchor = Date.parse(JSON.parse(runCli(f, ["automation", "show", "interval-job"]).stdout).schedule.anchoredAt);
  setClock(f, DUE_MS + 30 * MIN);
  assert.equal(runCli(f, ["automation", "resume", "cron-job"]).code, 0);
  const intervalResume = JSON.parse(runCli(f, ["automation", "resume", "interval-job"]).stdout);
  assert.equal(Date.parse(intervalResume.schedule.anchoredAt), anchor, "resume re-anchored an unchanged interval");
  assert.equal(Date.parse(intervalResume.nextDueAt), DUE_MS + 31 * MIN);
  setClock(f, DUE_MS + 31 * MIN); // one genuinely new minute after resume
  await waitFor(() => f.model.requests.length === 2);
  assert.equal((await settledOccurrence(f, "cron-job", DUE_MS + 31 * MIN)).outcome, "completed");
  assert.equal((await settledOccurrence(f, "interval-job", DUE_MS + 31 * MIN)).outcome, "completed");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(f.model.requests.length, 2, "the paused period was replayed");
  // The expired one-shot is not revived by resume; resume itself succeeds
  // (the job was paused) but eligibility stays expired.
  const expiredResume = runCli(f, ["automation", "resume", "one-job"]);
  assert.equal(expiredResume.code, 0, expiredResume.stderr);
  assert.equal(JSON.parse(expiredResume.stdout).nextDueAt, null);
  assert.equal(JSON.parse(runCli(f, ["automation", "show", "one-job"]).stdout).scheduledState, "expired");
  await stopServe(serve);
});

test("pausing while a run is active leaves that run on its start-time plan snapshot; pending edits keep the old plan and a confirmed policy edit never resets an unchanged interval anchor", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  setClock(f, DUE_MS - 90 * MIN);
  // 2-minute timeout under the controlled clock: advancing past one minute
  // while an edit is pending or confirmed must not kill the running snapshot.
  addEvery(f, "snapshot-job", "1m", ["--timeout", "2m"], "SNAPSHOT-ORIGINAL-TASK");
  const held = gate(textResponse("FIRST-FIRE-ORIGINAL TIMEOUT-2M"), true);
  f.model.jobs.push(held);
  setClock(f, DUE_MS - 89 * MIN);
  const serve = startServe(f);
  await waitStarted(serve);
  await waitFor(() => f.model.requests.length === 1);
  assert.match(f.model.requests[0], /SNAPSHOT-ORIGINAL-TASK/);

  // Pause during the active run: the current child keeps running.
  assert.equal(runCli(f, ["automation", "pause", "snapshot-job"]).code, 0);

  // A noninteractive unconfirmed edit fails before mutation. Advance the
  // controlled clock 90s: the 2-minute snapshot has not timed out, so the
  // original request is still the only one in flight (old plan stays live).
  const declined = runCli(f, ["automation", "update", "snapshot-job", "--timeout", "1m"]);
  assert.notEqual(declined.code, 0);
  assert.match(declined.stderr, /--yes/i);
  setClock(f, DUE_MS - 89 * MIN + 90_000);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(f.model.requests.length, 1, "a pending edit timed the active run off its old snapshot");
  assert.match(f.model.requests[0], /SNAPSHOT-ORIGINAL-TASK/);

  // An approved timeout edit while the run is active never resets the interval
  // anchor (a policy edit, not an interval change) and does not affect the
  // in-flight child: advancing past the NEW one-minute threshold but not the
  // old two-minute snapshot leaves the old run alive.
  const approved = runCli(f, ["automation", "update", "snapshot-job", "--timeout", "1m", "--yes"]);
  assert.equal(approved.code, 0, approved.stderr);
  const anchorBefore = Date.parse(JSON.parse(approved.stdout).schedule.anchoredAt);
  assert.equal(anchorBefore, DUE_MS - 90 * MIN, "a timing-policy edit reset the interval anchor");
  assert.equal(JSON.parse(approved.stdout).timeoutMinutes, 1);
  setClock(f, DUE_MS - 89 * MIN + 100_000); // 100s after start (>1m new, <2m old)
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(f.model.requests.length, 1, "the new timeout was applied retroactively to the running snapshot");
  assert.match(f.model.requests[0], /SNAPSHOT-ORIGINAL-TASK/);
  assert.doesNotMatch(f.model.requests[0], /TIMEOUT-1/);
  // The run is still genuinely active (not yet settled) past the new 1m limit.
  const stillActive = JSON.parse(runCli(f, ["automation", "show", "snapshot-job"]).stdout);
  assert.equal(stillActive.latestRun.outcome, "unknown");
  assert.equal(stillActive.latestRun.endedAt, null);

  // Past the original two-minute snapshot the active run times out honestly.
  setClock(f, DUE_MS - 89 * MIN + 125_000);
  await waitFor(() => /settled as timeout/.test(serve.stderr));
  held.release(); // unblock the killed child's held model connection
  await stopServe(serve);
});
test("an approved interval change gets a new anchor; old grid occurrences never fire after it", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  setClock(f, DUE_MS - 2 * MIN);
  addEvery(f, "reanchor", "1m", ["--timeout", "1h"]);
  const oldAnchor = Date.parse(JSON.parse(runCli(f, ["automation", "show", "reanchor"]).stdout).schedule.anchoredAt);
  assert.equal(runCli(f, ["automation", "pause", "reanchor"]).code, 0);
  const serve = startServe(f);
  await waitStarted(serve);
  setClock(f, DUE_MS + MIN); // old 1m grid would have many due points now
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(f.model.requests.length, 0, "a paused job admitted work");

  const changed = runCli(f, ["automation", "update", "reanchor", "--every", "5m", "--yes"]);
  assert.equal(changed.code, 0, changed.stderr);
  const newAnchor = Date.parse(JSON.parse(changed.stdout).schedule.anchoredAt);
  assert.ok(Math.abs(newAnchor - (DUE_MS + MIN)) < 5_000);
  assert.ok(newAnchor > oldAnchor);

  f.model.jobs.push(gate(textResponse("NEW-BEAT")));
  assert.equal(runCli(f, ["automation", "resume", "reanchor"]).code, 0);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(f.model.requests.length, 0, "a stale old-grid occurrence fired after re-anchoring");
  setClock(f, newAnchor + 5 * MIN);
  await waitFor(() => f.model.requests.length === 1);
  await settledOccurrence(f, "reanchor", newAnchor + 5 * MIN);
  await stopServe(serve);
});
test("a consumed one-shot edited to a new --at keeps its history and fires the new occurrence without corrupting the ledger", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addJob(f, "reschedule-one", ["--catch-up", "120m"]);
  f.model.jobs.push(gate(textResponse("FIRST-ONE-SHOT")));
  setClock(f, DUE_MS);
  const serve = startServe(f);
  await waitStarted(serve);
  await waitFor(() => f.model.requests.length === 1);
  const first = await settle(f, "reschedule-one");
  assert.equal(first.outcome, "completed");

  // Confirm-required update to a later one-shot instant.
  const updated = runCli(f, ["automation", "update", "reschedule-one", "--at", "2030-06-01T10:30", "--yes"]);
  assert.equal(updated.code, 0, updated.stderr);
  const view = JSON.parse(runCli(f, ["automation", "show", "reschedule-one"]).stdout);
  assert.match(view.schedule.resolvedLocal, /2030-06-01 10:30/);
  // The historical consumed entry is retained; the ledger is not corrupt.
  const outcomes = (view.scheduleOccurrences as Array<{ status: string; outcome?: string }>).map((e) => e.outcome);
  assert.ok(outcomes.includes("completed"), JSON.stringify(view.scheduleOccurrences));

  f.model.jobs.push(gate(textResponse("SECOND-ONE-SHOT")));
  setClock(f, Date.parse("2030-06-01T02:30:00.000Z")); // 10:30 Shanghai
  await waitFor(() => f.model.requests.length === 2);
  const entries = await settle(f, "reschedule-one");
  assert.equal(entries.outcome, "completed");
  assert.equal(entries.runId !== first.runId, true);
  await stopServe(serve);
});

test("a paused queued job discards its pending minute even when a slot frees, without queuing an old occurrence", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addCron(f, "holder-a", "0 9 * * *", ["--timeout", "1h"]);
  addCron(f, "holder-b", "0 9 * * *", ["--timeout", "1h"]);
  addCron(f, "paused-waiter", "* * * * *", ["--timeout", "1h"]);
  const gateA = gate(textResponse("HOLD-A"), true);
  const gateB = gate(textResponse("HOLD-B"), true);
  f.model.jobs.push(gateA, gateB);
  setClock(f, DUE_MS);
  const serve = startServe(f);
  await waitStarted(serve);
  await waitFor(() => f.model.requests.length === 2);
  // Capacity is full; the waiter's minute is still pending. Pause it: that
  // minute is discarded as lateness-skipped and is never admitted afterward.
  assert.equal(runCli(f, ["automation", "pause", "paused-waiter"]).code, 0);
  // Pause discards the not-started pending minute (no queue, no backlog).
  await waitFor(() => {
    const view = JSON.parse(runCli(f, ["automation", "show", "paused-waiter"]).stdout);
    const entry = (view.scheduleOccurrences as Array<Record<string, unknown>>).find((e) => Number(e.dueMs) === DUE_MS);
    return entry?.outcome === "lateness-skipped";
  }, 200);
  const skipped = (JSON.parse(runCli(f, ["automation", "show", "paused-waiter"]).stdout).scheduleOccurrences as Array<Record<string, unknown>>).find((e) => Number(e.dueMs) === DUE_MS);
  assert.equal(skipped?.outcome, "lateness-skipped");
  gateA.release();
  gateB.release();
  assert.equal(f.model.requests.length, 2, "a paused queued job was admitted after capacity freed");
  await stopServe(serve);
});

test("a confirmed profile change reaches the scheduled child; caller defaults never override the saved binding", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  const trace = join(f.root, "profile-trace.log");
  writeFileSync(join(f.bin, "lark-cli"), `#!/bin/sh
case "$1 $2" in
  "profile list") printf '%s' '[{"name":"local-default","appId":"local-default","brand":"feishu","active":true,"effective":true},{"name":"extra-profile","appId":"extra-profile","brand":"feishu","active":false,"effective":false}]' ;;
  *) printf 'LARK_PROFILE=%s\n' "$LARK_PROFILE" >> '${trace}'; echo sent ;;
esac
`, { mode: 0o755 });
  addJob(f, "profile-job");
  // Ambient caller profile cannot replace the saved binding, even confirmed.
  const ambient = runCli(f, ["automation", "update", "profile-job", "--yes"]);
  assert.notEqual(ambient.code, 0);
  const changed = runCli(f, ["automation", "update", "profile-job", "--lark-profile", "extra-profile", "--yes"]);
  assert.equal(changed.code, 0, changed.stderr);
  assert.equal(JSON.parse(changed.stdout).profile, "extra-profile");
  f.model.jobs.push(gate(textResponse("PROFILED")));
  setClock(f, DUE_MS);
  const serve = startServe(f, { LARK_PROFILE: "local-default" });
  await waitStarted(serve);
  await waitFor(() => f.model.requests.length === 1);
  await settle(f, "profile-job");
  await stopServe(serve);
  assert.match(readFileSync(trace, "utf8"), /LARK_PROFILE=extra-profile/);
  assert.doesNotMatch(readFileSync(trace, "utf8"), /LARK_PROFILE=local-default/);
});

test("the old plan keeps firing while a TTY update awaits confirmation; approval anchors the new interval at approval, not before", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  // Old beat: 1-minute interval enabled well before DUE_MS.
  setClock(f, DUE_MS - 5 * MIN);
  addEvery(f, "pending-edit", "1m", ["--timeout", "1h"], "OLD-PLAN-TASK");
  f.model.jobs.push(gate(textResponse("OLD-PLAN-FIRE"), true));
  const heldGate = f.model.jobs[0]!;
  setClock(f, DUE_MS);
  const serve = startServe(f);
  await waitStarted(serve);
  await waitFor(() => f.model.requests.length === 1);
  assert.match(f.model.requests[0], /OLD-PLAN-TASK/);

  // Open a TTY update and leave the confirmation UNANSWERED while the clock
  // crosses the next old-grid minute: that minute fires on the OLD plan.
  const python = [
    "import os,pty,re,select,sys,time",
    "cwd=sys.argv[1]; exe=sys.argv[2]; argv=eval(sys.argv[3]); pattern=sys.argv[4]; marker=sys.argv[5]",
    "pid,fd=pty.fork()",
    "if pid==0:",
    " os.chdir(cwd); os.execvpe(exe,[exe]+argv,dict(os.environ))",
    "out=b''; replied=False; end=time.time()+60",
    "while time.time()<end:",
    " r,_,_=select.select([fd],[],[],0.1)",
    " if r:",
    "  try: out+=os.read(fd,65536)",
    "  except OSError:",
    "   _,st=os.waitpid(pid,0); open(marker,'wb').write(out); sys.exit(os.waitstatus_to_exitcode(st))",
    " if not replied and re.search(pattern,out.decode('utf-8','replace'),re.I):",
    "  replied=True; open(marker+'.ready','w').write('ready')",
    " if os.path.exists(marker+'.proceed'):",
    "  time.sleep(0.2); os.write(fd,b'y\\n')",
    " p,st=os.waitpid(pid,os.WNOHANG)",
    " if p:",
    "  open(marker,'wb').write(out); sys.exit(os.waitstatus_to_exitcode(st))",
    "open(marker,'wb').write(b'timeout')",
  ].join("\n");
  const marker = join(f.root, "pending-edit-pty");
  const child = spawn("python3", ["-c", python, f.root, process.execPath, JSON.stringify([cli, "automation", "update", "pending-edit", "--every", "5m"]), "Apply this update", marker], {
    env: baseEnv(f, { TERM: "xterm-256color", COLUMNS: "120", LINES: "40" }),
  });
  let exitCode: number | null = null;
  child.on("close", (code) => { exitCode = code; });
  await waitFor(() => existsSync(marker + ".ready"));

  // Advance one old-grid minute while the confirmation prompt is still open.
  // The held first run occupies the job slot, so this minute is overlap-skipped
  // (not queued, not re-run): the uncommitted edit keeps the old plan but no
  // second child starts.
  setClock(f, DUE_MS + MIN);
  const minuteTwo = await settledOccurrence(f, "pending-edit", DUE_MS + MIN);
  assert.equal(minuteTwo.outcome, "overlap-skipped");
  assert.equal(f.model.requests.length, 1);

  // Approve now at a known controlled instant (below); the new 5-minute anchor
  // must equal this approval instant, not any earlier pending-confirmation time.
  const approvalAt = DUE_MS + 3 * MIN;
  setClock(f, approvalAt);
  writeFileSync(marker + ".proceed", "go");
  await waitFor(() => existsSync(marker));
  const approved = JSON.parse(runCli(f, ["automation", "show", "pending-edit"]).stdout);
  assert.equal(approved.schedule.intervalMinutes, 5);
  const anchor = Date.parse(approved.schedule.anchoredAt);
  // The new anchor is the controlled APPROVAL instant — not any time while
  // confirmation was pending (DUE_MS+1m), and not before.
  assert.ok(Math.abs(anchor - approvalAt) < 1000, `anchor ${anchor} != approval ${approvalAt}`);

  // Just past the anchor is before the new 5-minute beat: nothing fires.
  setClock(f, anchor + MIN);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(f.model.requests.length, 1, "an old-grid occurrence fired before anchor+interval");

  // The held first run still occupies the slot. Release it and wait for its
  // child to actually exit and settle before advancing the clock, so the next
  // grid point is admitted (not raced as overlap-skipped).
  heldGate.release();
  await waitFor(() => {
    const shown = JSON.parse(runCli(f, ["automation", "show", "pending-edit"]).stdout);
    const first = (shown.scheduleOccurrences as Array<Record<string, unknown>>).find((e) => Number(e.dueMs) === DUE_MS);
    return first?.status === "settled" && first?.outcome === "completed";
  }, 300);
  f.model.jobs.push(gate(textResponse("NEW-PLAN-FIRE")));
  setClock(f, anchor + 5 * MIN); // first 5-minute grid after approval
  await waitFor(() => f.model.requests.length === 2, 300);
  assert.match(f.model.requests[1], /OLD-PLAN-TASK/);
  await stopServe(serve);
});

test("cancel stops the Trigger-owned active run through its supervisor and records cancellation without rollback or retry", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addJob(f, "cancel-sched", ["--timeout", "1h"], "CANCEL-SCHED-TASK");
  const held = gate(textResponse("HELD-SCHED"), true);
  f.model.jobs.push(held);
  setClock(f, DUE_MS);
  const serve = startServe(f);
  await waitStarted(serve);
  await waitFor(() => f.model.requests.length === 1);
  const before = await occurrence(f, "cancel-sched");
  assert.equal(before.status, "running");

  const cancel = runCli(f, ["automation", "cancel", "cancel-sched"]);
  assert.equal(cancel.code, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).outcome, "cancelled");
  held.release(); // unblock the killed child's open model connection so it cannot hang the suite
  const settledEntry = await settle(f, "cancel-sched");
  assert.equal(settledEntry.outcome, "cancelled");
  assert.equal(settledEntry.runId, before.runId);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(f.model.requests.length, 1, "the cancelled occurrence was retried");
  const shown = JSON.parse(runCli(f, ["automation", "show", "cancel-sched"]).stdout);
  assert.equal(shown.latestRun.outcome, "cancelled");
  // The one-shot occurrence is consumed by having started: no second dispatch.
  setClock(f, DUE_MS + 30 * MIN);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(f.model.requests.length, 1);
  await stopServe(serve);
});

test("serving bounds retained outputs at 30 days without pruning definitions, active work, corrupt evidence, symlinks, or unrelated files", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addJob(f, "retain-job", ["--catch-up", "1m"]);
  f.model.jobs.push(gate(textResponse("RETAINED-FIRE")));
  setClock(f, DUE_MS);
  const serve = startServe(f);
  await waitStarted(serve);
  const fired = await settle(f, "retain-job");

  const jobDir = join(f.jobs, "jobs", "retain-job");
  const oldRunId = fired.runId as string;
  const oldLog = join(jobDir, "runs", `${oldRunId}.stdout.log`);
  writeFileSync(oldLog, "stale");
  const oldSeconds = new Date(Date.now() - 31 * 86_400_000).getTime() / 1000;
  utimesSync(oldLog, oldSeconds, oldSeconds);
  // An old artifact with an unfamiliar filename is never a pruning target.
  const unrelated = join(jobDir, "runs", "20000101T000000Z-sched-1-old.stdout.log");
  writeFileSync(unrelated, "keep me");
  utimesSync(unrelated, oldSeconds, oldSeconds);
  // A symlink escaping managed state is never followed during cleanup.
  const outside = join(f.root, "outside-trigger.txt");
  writeFileSync(outside, "survive");
  utimesSync(outside, oldSeconds, oldSeconds);
  const link = join(jobDir, "runs", "escape.log");
  const { symlinkSync } = await import("node:fs");
  symlinkSync(outside, link);
  const oldScratch = join(jobDir, "scratch", oldRunId);
  mkdirSync(oldScratch, { recursive: true });
  writeFileSync(join(oldScratch, "x"), "stale scratch");
  utimesSync(oldScratch, oldSeconds, oldSeconds);
  const corruptDir = join(f.jobs, "jobs", "corrupt-retain");
  mkdirSync(corruptDir, { recursive: true });
  writeFileSync(join(corruptDir, "job.json"), "{ also broken");
  const corruptOld = join(corruptDir, "runs", "20000101T000000Z-sched-7-old.stdout.log");
  mkdirSync(join(corruptDir, "runs"), { recursive: true });
  writeFileSync(corruptOld, "corrupt stale");
  utimesSync(corruptOld, oldSeconds, oldSeconds);

  // Restart triggers startup pruning; active work is not present, definitions stay.
  await stopServe(serve);
  const restarted = startServe(f);
  await waitStarted(restarted);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(existsSync(oldLog), false);
  assert.ok(existsSync(unrelated), "an unrelated filename was pruned");
  assert.ok(existsSync(link) && existsSync(outside), "a symlink was followed or its target deleted");
  assert.equal(readFileSync(outside, "utf8"), "survive");
  assert.equal(existsSync(oldScratch), false);
  assert.ok(existsSync(join(jobDir, "job.json")), "cleanup pruned a task definition");
  assert.equal(readFileSync(join(corruptDir, "job.json"), "utf8"), "{ also broken");
  assert.ok(existsSync(corruptOld), "a corrupt job's outputs were traversed/pruned");
  await stopServe(restarted);
});


test("an approved cron expression edit makes the pre-edit due minute stale (no run, skip recorded, fresh minute fires)", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  // Old rule fires every minute at DUE_MS; the approved change moves it to 10:00 only.
  addCron(f, "expr-edit", "* * * * *", ["--timeout", "1h"]);
  const serve = startServe(f);
  await waitStarted(serve);
  // Pause before the minute, approve a new expression while paused.
  assert.equal(runCli(f, ["automation", "pause", "expr-edit"]).code, 0);
  setClock(f, DUE_MS);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(f.model.requests.length, 0, "a paused job admitted work");
  const changed = runCli(f, ["automation", "update", "expr-edit", "--cron", "0 10 * * *", "--yes"]);
  assert.equal(changed.code, 0, changed.stderr);
  assert.equal(runCli(f, ["automation", "resume", "expr-edit"]).code, 0);
  // The Trigger already emitted a skip for the old minute before the edit; the
  // new expression does not contain 09:00, so even if a stale launch lingers it
  // must not start a child. Advance through 09:00..09:59: no requests.
  setClock(f, DUE_MS + 30 * MIN);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(f.model.requests.length, 0, "the old cron minute fired after an expression edit");
  await stopServe(serve);
});

test("retention never deletes outputs of a job with a corrupt schedule ledger", async () => {
  const f = await fixture();
  gateServers.push(f.model.server);
  addJob(f, "bad-ledger", ["--catch-up", "1m"]);
  f.model.jobs.push(gate(textResponse("BAD-LEDGER-FIRE")));
  setClock(f, DUE_MS);
  const serve = startServe(f);
  await waitStarted(serve);
  await settle(f, "bad-ledger");
  const fired = await occurrence(f, "bad-ledger");
  const jobDir = join(f.jobs, "jobs", "bad-ledger");
  const oldLog = join(jobDir, "runs", `${String(fired.runId)}.stdout.log`);
  const oldSeconds = new Date(Date.now() - 31 * 86_400_000).getTime() / 1000;
  utimesSync(oldLog, oldSeconds, oldSeconds);
  // Corrupt the ledger AFTER the run: retention must now leave its outputs.
  writeFileSync(schedulePath(f, "bad-ledger"), "{ broken");
  await stopServe(serve);
  const restarted = startServe(f);
  await waitStarted(restarted);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(existsSync(oldLog), "a corrupt-ledger job's old output was pruned");
  await stopServe(restarted);
});
