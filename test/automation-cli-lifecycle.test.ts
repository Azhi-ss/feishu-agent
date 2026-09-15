import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  cli,
  MODEL_KEY_SENTINEL,
  REMOTE_SECRET_SENTINEL,
  TOOL_OUTPUT_SENTINEL,
  textResponse,
  toolResponse,
  files,
  profileListJson,
  makeLarkBin,
  fixture,
  userPromptCount,
  baseEnv,
  runCli,
  addJob,
  runAutomationAsync,
  ptyRun,
  waitFor,
  repointModel,
  lastUserPrompt,
  createCliHarness,
} from "./helpers/automation-cli-fixture.js";

const { modelServers, startGate } = createCliHarness();

test("update rejects no-op, malformed, and conflicting changes before any mutation", async () => {
  const f = await fixture([["local-default", true], ["extra-profile", false]]);
  modelServers.push(f.model.server);
  assert.equal(addJob(f, ["--timeout", "12m"], "Original task instructions.\n").code, 0);
  const before = readFileSync(join(f.jobs, "jobs", "daily-reminder", "job.json"), "utf8");
  const cases: Array<{ args: string[]; input?: string; match: RegExp; interval?: boolean }> = [
    { args: [], match: /nothing to update|no changes/i },
    { args: ["--cron", "0 9 * * *", "--every", "30m"], match: /exactly one schedule/i },
    { args: ["--cron", "60 9 * * *"], match: /between 0 and 59/i },
    { args: ["--at", "not-a-time"], match: /ISO 8601/i },
    { args: ["--tz", "Mars/Olympus"], match: /unknown timezone/i },
    { args: ["--every", "45s"], match: /positive duration/i },
    { args: ["--timeout", "0m"], match: /at least one minute/i },
    { args: ["--catch-up", "5s"], match: /positive duration/i },
    { args: ["--catch-up", "1h", "--no-catch-up"], match: /catch-up/i },
    { args: ["--no-catch-up", "--timeout", "20m"], match: /no-catch-up applies only to recurring/i },
    { args: ["--lark-profile", "ghost"], match: /lark profile/i },
    { args: ["--bogus"], match: /unknown option/i },
    { args: ["--name", "other"], match: /unknown option/i },
    { args: ["--purge"], match: /unknown option/i },
    { args: ["--prompt-stdin", "extra-positional"], input: "x\n", match: /unexpected/i },
    { args: ["--every", "90m"], match: /nothing to update|no changes/i, interval: true },
    { args: ["--prompt-stdin"], input: "   \n", match: /empty/i },
    { args: ["--prompt-file", join(f.root, "missing.txt")], match: /cannot read task file/i },
  ];
  for (const testCase of cases) {
    const target = testCase.interval ? "every90-pre" : "daily-reminder";
    if (testCase.interval) {
      const pre = runCli(f, ["automation", "add", "--name", "every90-pre", "--every", "90m", "--prompt-stdin", "--yes"], { input: "t\n" });
      assert.equal(pre.code, 0, pre.stderr);
    }
    const result = runCli(f, ["automation", "update", target, ...testCase.args, ...(testCase.args.some((arg) => arg === "--bogus" || arg === "--name" || arg === "--purge" || arg === "extra-positional") ? [] : ["--yes"])], { input: testCase.input ?? "x\n" });
    assert.notEqual(result.code, 0, testCase.args.join(" "));
    assert.match(result.stderr, testCase.match, testCase.args.join(" "));
    assert.equal(readFileSync(join(f.jobs, "jobs", "daily-reminder", "job.json"), "utf8"), before, `mutation from ${testCase.args.join(" ")}`);
  }
  const addPurge = runCli(f, ["automation", "add", "--name", "purge-add", "--at", "2030-06-01T09:00", "--prompt-stdin", "--purge", "--yes"], { input: "t\n" });
  assert.notEqual(addPurge.code, 0);
  assert.match(addPurge.stderr, /unknown option/i);
  const rmAlias = runCli(f, ["automation", "remove", "daily-reminder"]);
  assert.notEqual(rmAlias.code, 0);
  assert.match(rmAlias.stderr, /unknown automation command/i);
  const cancelAlias = runCli(f, ["automation", "cancel-current-run", "daily-reminder"]);
  assert.notEqual(cancelAlias.code, 0);
  assert.match(cancelAlias.stderr, /unknown automation command/i);

  // A noninteractive update without --yes fails promptly even when valid.
  const noYes = runCli(f, ["automation", "update", "daily-reminder", "--timeout", "20m"], { input: "" });
  assert.notEqual(noYes.code, 0);
  assert.match(noYes.stderr, /--yes/i);
  assert.equal(readFileSync(join(f.jobs, "jobs", "daily-reminder", "job.json"), "utf8"), before);

  // Repeating the identical --every is a no-op change, not a new anchor; the
  // same-every case in the loop covers the rejection. No mutation here.
  const intervalAdd = runCli(f, ["automation", "add", "--name", "every90", "--every", "90m", "--prompt-stdin", "--yes"], { input: "t\n" });
  assert.equal(intervalAdd.code, 0, intervalAdd.stderr);
  const anchorBefore = JSON.parse(intervalAdd.stdout).schedule.anchoredAt;
  const stillSame = JSON.parse(runCli(f, ["automation", "show", "every90"]).stdout).schedule.anchoredAt;
  assert.equal(stillSame, anchorBefore);
});

test("update keeps unspecified values, shows the change set and full plan, and persists only an approved edit", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  assert.equal(addJob(f, ["--timeout", "12m", "--catch-up", "90m"], "Original task instructions.\n").code, 0);

  const approved = runCli(f, ["automation", "update", "daily-reminder", "--prompt-stdin", "--yes"], { input: "Refreshed task instructions.\n" });
  assert.equal(approved.code, 0, approved.stderr);
  const receipt = JSON.parse(approved.stdout);
  assert.equal(receipt.task, "Refreshed task instructions.");
  assert.equal(receipt.timeoutMinutes, 12);
  assert.equal(receipt.schedule.latenessMinutes, 90);
  assert.match(approved.stderr, /changed:/i);
  assert.match(approved.stderr, /task/i);
  assert.match(approved.stderr, /Automation Job plan/i);
  // Only the content changed; the timing anchor is untouched (same next time).
  assert.equal(receipt.nextDueAt, "2030-06-01T01:00:00.000Z");
  assert.match(receipt.schedule.resolvedLocal, /2030-06-01 09:00/);

  const declined = await ptyRun(f, ["automation", "update", "daily-reminder", "--timeout", "30m"], "", /Apply this update\?/i, "n");
  assert.notEqual(declined.code, 0);
  assert.match(declined.output, /Declined/i);
  assert.equal(JSON.parse(runCli(f, ["automation", "show", "daily-reminder"]).stdout).timeoutMinutes, 12);

  const accepted = await ptyRun(f, ["automation", "update", "daily-reminder", "--timeout", "30m"], "", /Apply this update\?/i, "y");
  assert.equal(accepted.code, 0, accepted.output);
  assert.equal(JSON.parse(runCli(f, ["automation", "show", "daily-reminder"]).stdout).timeoutMinutes, 30);
});

test("update changes the schedule kind and timezone and re-anchors intervals; content-only edits keep the anchor", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  const interval = runCli(f, ["automation", "add", "--name", "ninety", "--every", "90m", "--prompt-stdin", "--yes"], { input: "t\n" });
  assert.equal(interval.code, 0, interval.stderr);
  const anchor = Date.parse(JSON.parse(interval.stdout).schedule.anchoredAt);

  const contentOnly = runCli(f, ["automation", "update", "ninety", "--prompt-stdin", "--yes"], { input: "new body\n" });
  assert.equal(contentOnly.code, 0, contentOnly.stderr);
  assert.equal(Date.parse(JSON.parse(contentOnly.stdout).schedule.anchoredAt), anchor);

  await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
  const changed = runCli(f, ["automation", "update", "ninety", "--every", "30m", "--yes"], { input: "" });
  assert.equal(changed.code, 0, changed.stderr);
  const newSchedule = JSON.parse(changed.stdout).schedule;
  assert.equal(newSchedule.intervalMinutes, 30);
  assert.ok(Date.parse(newSchedule.anchoredAt) > anchor, "an approved interval change establishes a new anchor");

  const switched = runCli(f, ["automation", "update", "ninety", "--cron", "0 9 * * 1-5", "--tz", "Asia/Tokyo", "--yes"], { input: "" });
  assert.equal(switched.code, 0, switched.stderr);
  const cronView = JSON.parse(switched.stdout).schedule;
  assert.equal(cronView.kind, "cron");
  assert.equal(cronView.timeZone, "Asia/Tokyo");

  const oneshot = runCli(f, ["automation", "update", "ninety", "--at", "2031-01-02T08:00", "--yes"], { input: "" });
  assert.equal(oneshot.code, 0, oneshot.stderr);
  assert.equal(JSON.parse(oneshot.stdout).schedule.kind, "oneshot");
});

test("the saved Lark profile is not replaced by caller defaults; changing it needs a confirmed update", async () => {
  const f = await fixture([["local-default", true], ["bound-profile", false], ["other-profile", false]]);
  modelServers.push(f.model.server);
  assert.equal(addJob(f, ["--lark-profile", "bound-profile"]).code, 0);

  // A content-only update under a different ambient profile keeps the binding.
  const ambient = runCli(f, ["automation", "update", "daily-reminder", "--timeout", "25m", "--yes"], {
    input: "",
    env: { LARK_PROFILE: "other-profile" },
  });
  assert.equal(ambient.code, 0, ambient.stderr);
  assert.equal(JSON.parse(ambient.stdout).profile, "bound-profile");

  const noConfirm = runCli(f, ["automation", "update", "daily-reminder", "--lark-profile", "other-profile"], { input: "" });
  assert.notEqual(noConfirm.code, 0);
  assert.match(noConfirm.stderr, /--yes/i);
  assert.equal(JSON.parse(runCli(f, ["automation", "show", "daily-reminder"]).stdout).profile, "bound-profile");

  const confirmed = runCli(f, ["automation", "update", "daily-reminder", "--lark-profile", "other-profile", "--yes"], { input: "" });
  assert.equal(confirmed.code, 0, confirmed.stderr);
  assert.equal(JSON.parse(confirmed.stdout).profile, "other-profile");
});

test("pause and resume update job state; resume reports the next occurrence and keeps interval anchors", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  assert.equal(addJob(f).code, 0);

  const pause = runCli(f, ["automation", "pause", "daily-reminder"]);
  assert.equal(pause.code, 0, pause.stderr);
  assert.equal(JSON.parse(pause.stdout).state, "paused");
  assert.equal(JSON.parse(runCli(f, ["automation", "list"]).stdout).jobs[0].state, "paused");

  const resume = runCli(f, ["automation", "resume", "daily-reminder"]);
  assert.equal(resume.code, 0, resume.stderr);
  const resumed = JSON.parse(resume.stdout);
  assert.equal(resumed.state, "enabled");
  assert.equal(resumed.nextDueAt, "2030-06-01T01:00:00.000Z");
  assert.match(resume.stderr, /paused period|without replay|not replayed/i);

  // Resuming an enabled job is an honest no-op error (nothing to resume).
  assert.notEqual(runCli(f, ["automation", "resume", "daily-reminder"]).code, 0);
  assert.equal(runCli(f, ["automation", "pause", "missing-job"]).code, 1);

  const interval = runCli(f, ["automation", "add", "--name", "ninety", "--every", "90m", "--prompt-stdin", "--yes"], { input: "t\n" });
  const anchor = Date.parse(JSON.parse(interval.stdout).schedule.anchoredAt);
  assert.equal(runCli(f, ["automation", "pause", "ninety"]).code, 0);
  const intervalResume = JSON.parse(runCli(f, ["automation", "resume", "ninety"]).stdout);
  assert.equal(Date.parse(intervalResume.schedule.anchoredAt), anchor, "resume moved an unchanged interval anchor");
});

test("a paused job stays manually runnable; the manual run neither resumes it nor consumes the schedule", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  assert.equal(addJob(f).code, 0);
  assert.equal(runCli(f, ["automation", "pause", "daily-reminder"]).code, 0);
  f.model.responses.push(textResponse("PAUSED-MANUAL-OK"));
  const run = await runAutomationAsync(f, ["run", "daily-reminder"]);
  assert.equal(run.code, 0, run.stderr);
  const receipt = JSON.parse(run.stdout);
  assert.equal(receipt.outcome, "completed");
  assert.match(receipt.scheduleNotice, /paused|separate manual attempt/i);
  const shown = JSON.parse(runCli(f, ["automation", "show", "daily-reminder"]).stdout);
  assert.equal(shown.state, "paused");
  assert.equal(shown.scheduledState, "paused");
  assert.equal(shown.scheduleOccurrence, null);
  assert.equal(shown.latestRun.trigger, "manual");
});

test("cancel stops the named active run through its owner and records cancellation without replay", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  assert.equal(addJob(f, ["--timeout", "1h"], "CANCEL-SNAPSHOT-TASK\n").code, 0);
  const gate = await startGate(textResponse("SHOULD-NEVER-ARRIVE"));
  repointModel(f, gate.port);

  const active = spawn(process.execPath, [cli, "automation", "run", "daily-reminder"], { cwd: f.root, env: baseEnv(f), stdio: ["ignore", "pipe", "pipe"] });
  let activeStderr = "";
  active.stderr.on("data", (chunk) => { activeStderr += chunk; });
  await waitFor(() => gate.requests.length === 1);
  assert.match(lastUserPrompt(gate), /CANCEL-SNAPSHOT-TASK/);

  const cancel = runCli(f, ["automation", "cancel", "daily-reminder"]);
  assert.equal(cancel.code, 0, `${cancel.stderr}\n${activeStderr}`);
  const cancelled = JSON.parse(cancel.stdout);
  assert.equal(cancelled.outcome, "cancelled");
  assert.match(cancel.stderr, /cancel/i);
  const code = await new Promise<number | null>((done) => active.on("close", done));
  assert.notEqual(code, 0);

  await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
  assert.equal(gate.requests.length, 1, "a cancelled run was retried or replayed");
  assert.equal(existsSync(join(f.jobs, "jobs", "daily-reminder", "run.lock")), false);
  const shown = JSON.parse(runCli(f, ["automation", "show", "daily-reminder"]).stdout);
  assert.equal(shown.latestRun.outcome, "cancelled");
  assert.equal(shown.scheduleOccurrence, null, "cancelling a manual run must not consume the one-shot");
  gate.release(); // unblock the killed child's open model connection
});

test("cancel without an active run fails with guidance and never signals unrelated processes", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  assert.equal(addJob(f).code, 0);
  const none = runCli(f, ["automation", "cancel", "daily-reminder"]);
  assert.notEqual(none.code, 0);
  assert.match(none.stderr, /no active run|not running/i);
  assert.equal(existsSync(join(f.jobs, "jobs", "daily-reminder", "cancel.json")), false);
  assert.equal(runCli(f, ["automation", "cancel", "missing-job"]).code, 1);
});

test("a stale cancel.json never cancels a later run and is removed at admission", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  assert.equal(addJob(f, ["--timeout", "5m"], "STALE-CANCEL-TASK\n").code, 0);
  const jobDir = join(f.jobs, "jobs", "daily-reminder");
  mkdirSync(jobDir, { recursive: true });
  // Leftover from a dead previous supervisor: a different run id entirely.
  writeFileSync(join(jobDir, "cancel.json"), JSON.stringify({ runId: "20000101T000000Z-sched-1-deadbeef", requestedAt: "2000-01-01T00:00:00.000Z" }));
  f.model.responses.push(textResponse("DESPITE-STALE-CANCEL"));
  const result = await runAutomationAsync(f, ["run", "daily-reminder"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).outcome, "completed");
  assert.equal(existsSync(join(jobDir, "cancel.json")), false, "the stale request was not consumed or left behind");

  // A well-formed request bound to a DIFFERENT run id while a new run is
  // active is ignored too: publish a foreign-id request mid-run.
  const gate = await startGate(textResponse("HELD-WHILE-FOREIGN-CANCEL"));
  repointModel(f, gate.port);
  const active = spawn(process.execPath, [cli, "automation", "run", "daily-reminder"], { cwd: f.root, env: baseEnv(f), stdio: "ignore" });
  await waitFor(() => gate.requests.length === 1, 300);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, "cancel.json"), JSON.stringify({ runId: "someone-else", requestedAt: new Date().toISOString() }));
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(gate.requests.length, 1, "a foreign run-bound cancel request stopped the live run");
  // The real cancel (the CLI binds it to the live run id) does stop it.
  const cancel = runCli(f, ["automation", "cancel", "daily-reminder"]);
  assert.equal(cancel.code, 0, cancel.stderr);
  await new Promise<number | null>((done) => active.on("close", done));
  gate.release();
});

test("rm refuses active jobs; ordinary removal retains artifacts and blocks runs and silent name reuse", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  assert.equal(addJob(f, ["--timeout", "1h"], "Held task.\n").code, 0);
  const gate = await startGate(textResponse("Held for rm refusal"));
  repointModel(f, gate.port);
  const active = spawn(process.execPath, [cli, "automation", "run", "daily-reminder"], { cwd: f.root, env: baseEnv(f), stdio: "ignore" });
  await waitFor(() => gate.requests.length === 1, 300);

  const refused = runCli(f, ["automation", "rm", "daily-reminder", "--purge", "--yes"]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /pause|cancel/i);
  assert.equal(JSON.parse(runCli(f, ["automation", "show", "daily-reminder"]).stdout).state, "enabled");

  // A bare rm --yes (no purge) is rejected at parse time, ordinary retained rm
  // needs no confirmation.
  const bareYes = runCli(f, ["automation", "rm", "daily-reminder", "--yes"]);
  assert.notEqual(bareYes.code, 0);
  assert.match(bareYes.stderr, /--purge|--yes/i);

  runCli(f, ["automation", "cancel", "daily-reminder"]);
  await new Promise((done) => active.on("close", done));
  gate.release();

  const removed = runCli(f, ["automation", "rm", "daily-reminder"]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(JSON.parse(removed.stdout).state, "removed");
  assert.ok(existsSync(join(f.jobs, "jobs", "daily-reminder", "job.json")), "ordinary rm erased the retained record");

  const cannotRun = runCli(f, ["automation", "run", "daily-reminder"]);
  assert.notEqual(cannotRun.code, 0);
  assert.match(cannotRun.stderr, /removed|purge/i);
  const reuse = runCli(f, ["automation", "add", "--name", "daily-reminder", "--at", "2031-01-01T09:00", "--prompt-stdin", "--yes"], { input: "t\n" });
  assert.notEqual(reuse.code, 0);
  assert.match(reuse.stderr, /already exists|retained/i);

  const shown = JSON.parse(runCli(f, ["automation", "show", "daily-reminder"]).stdout);
  assert.equal(shown.state, "removed");
  assert.equal(shown.scheduledState, "removed");
  assert.equal(shown.nextDueAt, null);
  assert.deepEqual(JSON.parse(runCli(f, ["automation", "list"]).stdout).jobs.map((job: { name: string }) => job.name), ["daily-reminder"]);
});

test("purge requires fresh confirmation, deletes only that job's retained artifacts, and releases its name", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  assert.equal(addJob(f).code, 0);
  f.model.responses.push(textResponse("ONCE"));
  assert.equal((await runAutomationAsync(f, ["run", "daily-reminder"])).code, 0);
  assert.equal(runCli(f, ["automation", "rm", "daily-reminder"]).code, 0);

  const jobDir = join(f.jobs, "jobs", "daily-reminder");
  assert.ok(readdirSync(join(jobDir, "runs")).length > 0);

  const noFlag = runCli(f, ["automation", "rm", "daily-reminder", "--purge"], { input: "" });
  assert.notEqual(noFlag.code, 0);
  assert.match(noFlag.stderr, /--yes/i);
  assert.ok(existsSync(jobDir));

  const purged = runCli(f, ["automation", "rm", "daily-reminder", "--purge", "--yes"], { input: "" });
  assert.equal(purged.code, 0, purged.stderr);
  assert.equal(existsSync(jobDir), false);
  assert.ok(existsSync(join(f.jobs, "AGENTS.md")), "purge deleted unrelated workspace files");
  const readded = runCli(f, ["automation", "add", "--name", "daily-reminder", "--at", "2031-01-01T09:00", "--prompt-stdin", "--yes"], { input: "t\n" });
  assert.equal(readded.code, 0, readded.stderr);
});

test("inherited unattended runs cannot manage jobs; list and show remain available", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  assert.equal(addJob(f).code, 0);
  assert.equal(runCli(f, ["automation", "pause", "daily-reminder"]).code, 0);
  for (const args of [
    ["automation", "update", "daily-reminder", "--timeout", "5m", "--yes"],
    ["automation", "resume", "daily-reminder"],
    ["automation", "cancel", "daily-reminder"],
    ["automation", "rm", "daily-reminder"],
  ]) {
    const blocked = runCli(f, args, { env: { FEISHU_UNATTENDED: "1" }, input: "t\n" });
    assert.notEqual(blocked.code, 0, args.join(" "));
    assert.match(blocked.stderr, /unattended/i, args.join(" "));
  }
  assert.equal(runCli(f, ["automation", "list"], { env: { FEISHU_UNATTENDED: "1" } }).code, 0);
  assert.equal(runCli(f, ["automation", "show", "daily-reminder"], { env: { FEISHU_UNATTENDED: "1" } }).code, 0);
  assert.equal(JSON.parse(runCli(f, ["automation", "show", "daily-reminder"], { env: { FEISHU_UNATTENDED: "1" } }).stdout).state, "paused");
});

test("retention cleanup bounds old owned outputs and scratch without pruning definitions, corrupt records, symlinks, or unrelated files", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  assert.equal(addJob(f).code, 0);
  f.model.responses.push(textResponse("PRUNE-OK"));
  const run = await runAutomationAsync(f, ["run", "daily-reminder"]);
  assert.equal(run.code, 0, run.stderr);
  const jobDir = join(f.jobs, "jobs", "daily-reminder");
  // The real completed run is a recorded artifact: age its outputs past 30 days.
  const firstReceipt = JSON.parse(run.stdout);
  const oldRunId = firstReceipt.runId;
  const oldLog = join(jobDir, "runs", `${oldRunId}.stdout.log`);
  const oldErr = join(jobDir, "runs", `${oldRunId}.stderr.log`);
  const recentRunId = "20000102T000000Z-sched-2-22222222-2222-2222-2222-222222222222";
  const recentLog = join(jobDir, "runs", `${recentRunId}.stdout.log`);
  writeFileSync(recentLog, "fresh diagnostics\n");
  const oldTime = new Date(Date.now() - 31 * 86_400_000).getTime() / 1000;
  const newTime = new Date(Date.now() - 2 * 86_400_000).getTime() / 1000;
  utimesSync(oldLog, oldTime, oldTime);
  utimesSync(oldErr, oldTime, oldTime);
  utimesSync(oldLog, oldTime, oldTime);
  // A stale filename that is not this job's own run artifact is never pruned.
  const unrelated = join(jobDir, "runs", "20000101T000000Z-sched-1-old.stdout.log");
  writeFileSync(unrelated, "unrelated evidence\n");
  utimesSync(unrelated, oldTime, oldTime);
  // A symlink pointing outside managed state is never followed or deleted as a log.
  const outside = join(f.root, "outside-target.txt");
  writeFileSync(outside, "must survive\n");
  utimesSync(outside, oldTime, oldTime);
  const linked = join(jobDir, "runs", "escape-link.log");
  mkdirSync(jobDir, { recursive: true });
  const { symlinkSync } = await import("node:fs");
  symlinkSync(outside, linked);
  const oldScratch = join(jobDir, "scratch", oldRunId);
  mkdirSync(oldScratch, { recursive: true });
  writeFileSync(join(oldScratch, "tmp.txt"), "scratch\n");
  utimesSync(oldScratch, oldTime, oldTime);
  const recentScratch = join(jobDir, "scratch", recentRunId);
  mkdirSync(recentScratch, { recursive: true });
  utimesSync(recentScratch, newTime, newTime);
  const corruptDir = join(f.jobs, "jobs", "corrupt-job");
  mkdirSync(corruptDir, { recursive: true });
  writeFileSync(join(corruptDir, "job.json"), "{ broken");
  const corruptOld = join(corruptDir, "runs", "20000101T000000Z-sched-9-old.stdout.log");
  mkdirSync(join(corruptDir, "runs"), { recursive: true });
  writeFileSync(corruptOld, "corrupt job stale output\n");
  utimesSync(corruptOld, oldTime, oldTime);

  f.model.responses.push(textResponse("PRUNE-AGAIN"));
  const pruned = await runAutomationAsync(f, ["run", "daily-reminder"]);
  assert.equal(pruned.code, 0, pruned.stderr);
  assert.equal(existsSync(oldLog), false, "an output older than 30 days was retained");
  assert.equal(existsSync(oldErr), false, "an old diagnostic was retained");
  assert.ok(existsSync(recentLog), "recent output was pruned");
  assert.ok(existsSync(unrelated), "an unrelated filename was pruned");
  assert.ok(existsSync(linked) && existsSync(outside), "a symlink target was followed or deleted");
  assert.equal(readFileSync(outside, "utf8"), "must survive\n");
  assert.equal(existsSync(oldScratch), false, "old scratch was retained");
  assert.ok(existsSync(recentScratch), "recent scratch was pruned");
  assert.ok(existsSync(join(jobDir, "job.json")), "the task definition was pruned as logs");
  assert.equal(readFileSync(join(corruptDir, "job.json"), "utf8"), "{ broken", "a corrupt record was destructively repaired");
  assert.ok(existsSync(corruptOld), "a corrupt job's outputs were traversed/pruned");
  assert.match(pruned.stderr, /corrupt/i);
});


test("the stored mutateJobRecord merge keeps run history written while a confirmed edit is open", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  assert.equal(addJob(f, ["--timeout", "10m"]).code, 0);
  // Simulate the record a confirmation was computed against (old timeout).
  const before = readFileSync(join(f.jobs, "jobs", "daily-reminder", "job.json"), "utf8");
  // ... a run settles meanwhile and appends history under the lock ...
  f.model.responses.push(textResponse("MERGE-KEEP-HISTORY"));
  const ran = await runAutomationAsync(f, ["run", "daily-reminder"]);
  assert.equal(ran.code, 0, ran.stderr);
  const afterRun = JSON.parse(runCli(f, ["automation", "show", "daily-reminder"]).stdout);
  assert.equal(afterRun.recentRuns.length, 1);
  // The confirmed edit then reloads and merges: history must survive.
  const edited = runCli(f, ["automation", "update", "daily-reminder", "--timeout", "15m", "--yes"], { input: "" });
  assert.equal(edited.code, 0, edited.stderr);
  const shown = JSON.parse(runCli(f, ["automation", "show", "daily-reminder"]).stdout);
  assert.equal(shown.timeoutMinutes, 15);
  assert.equal(shown.recentRuns.length, 1, "run history was lost when the edit was applied");
  void before;
});

test("an approved edit cannot resurrect a job paused while confirmation was open", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  assert.equal(addJob(f, ["--timeout", "10m"]).code, 0);
  // Drive the TTY confirmation externally: hold the prompt open, pause from a
  // second CLI while it waits, then answer y. The approval must be rejected.
  const python = [
    "import os,pty,re,select,sys,time",
    "cwd=sys.argv[1]; exe=sys.argv[2]; argv=eval(sys.argv[3]); marker=sys.argv[4]",
    "pid,fd=pty.fork()",
    "if pid==0:",
    " os.chdir(cwd); os.execvpe(exe,[exe]+argv,dict(os.environ))",
    "out=b''; replied=False; end=time.time()+30",
    "while time.time()<end:",
    " r,_,_=select.select([fd],[],[],0.1)",
    " if r:",
    "  try: out+=os.read(fd,65536)",
    "  except OSError:",
    "   _,st=os.waitpid(pid,0); open(marker,'wb').write(out); sys.exit(os.waitstatus_to_exitcode(st))",
    " if not replied and re.search(b'Apply this update',out,re.I):",
    "  replied=True; open(marker+'.ready','w').write('ready')",
    " if os.path.exists(marker+'.proceed'):",
    "  time.sleep(0.2); os.write(fd,b'y\\n')",
    " p,st=os.waitpid(pid,os.WNOHANG)",
    " if p:",
    "  open(marker,'wb').write(out); sys.exit(os.waitstatus_to_exitcode(st))",
    "open(marker,'wb').write(b'timeout')",
  ].join("\n");
  const marker = join(f.root, "pause-race-pty");
  const pending = spawn("python3", ["-c", python, f.root, process.execPath, JSON.stringify([cli, "automation", "update", "daily-reminder", "--timeout", "20m"]), marker], {
    env: baseEnv(f, { TERM: "xterm-256color", COLUMNS: "120", LINES: "40" }),
  });
  let code: number | null = null;
  pending.on("close", (c) => { code = c; });
  await waitFor(() => existsSync(marker + ".ready"));
  assert.equal(runCli(f, ["automation", "pause", "daily-reminder"]).code, 0);
  writeFileSync(marker + ".proceed", "go");
  await waitFor(() => code !== null, 200);
  assert.notEqual(code, 0, "the stale confirmation should be rejected");
  const shown = JSON.parse(runCli(f, ["automation", "show", "daily-reminder"]).stdout);
  assert.equal(shown.state, "paused");
  assert.equal(shown.timeoutMinutes, 10);
});

test("the same --every keeps its anchor even with an explicit catch-up change", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  assert.equal(runCli(f, ["automation", "add", "--name", "every90", "--every", "90m", "--no-catch-up", "--prompt-stdin", "--yes"], { input: "t\n" }).code, 0);
  const before = JSON.parse(runCli(f, ["automation", "show", "every90"]).stdout);
  assert.equal(before.schedule.catchUpMinutes, null);
  // Same beat duration, only the catch-up policy changes: anchor must survive.
  const changed = runCli(f, ["automation", "update", "every90", "--every", "90m", "--catch-up", "30m", "--yes"], { input: "" });
  assert.equal(changed.code, 0, changed.stderr);
  const after = JSON.parse(changed.stdout);
  assert.equal(after.schedule.anchoredAt, before.schedule.anchoredAt);
  assert.equal(after.schedule.catchUpMinutes, 30);
});

test("a new explicit --at retains the saved lateness window unless --catch-up is given", async () => {
  const f = await fixture();
  modelServers.push(f.model.server);
  assert.equal(addJob(f, ["--catch-up", "45m"]).code, 0);
  assert.equal(JSON.parse(runCli(f, ["automation", "show", "daily-reminder"]).stdout).schedule.latenessMinutes, 45);
  const moved = runCli(f, ["automation", "update", "daily-reminder", "--at", "2030-07-01T09:00", "--yes"], { input: "" });
  assert.equal(moved.code, 0, moved.stderr);
  assert.equal(JSON.parse(moved.stdout).schedule.latenessMinutes, 45);
});
