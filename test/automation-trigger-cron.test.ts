import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
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
  runCli,
  addCron,
  setClock,
  waitStarted,
  stopServe,
  waitFor,
  settle,
  settledOccurrence,
  createTriggerHarness,
} from "./helpers/automation-trigger-fixture.js";

const { gateServers, startServe } = createTriggerHarness();

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
