# Test Timing — Readiness Budgets and Clock-Independent Assertions

Two conventions for time-sensitive tests. Both come from real flakes fixed in
2026-09 (see the diagnosis notes below), and both exist because this suite runs
dozens of spawned CLI/PTY children in parallel — a loaded machine, not an idle one.

## 1. Readiness waits go through the shared budget

Wait for "a child process reached this point" with the shared helper, and raise
its **one** default instead of passing a hardcoded millisecond budget at the call
site.

- Seam: `waitFor` in `test/helpers/automation-cli-fixture.ts` (~70 call sites).
- Budget: 300 × 50ms = 15s. The old 5s default was calibrated for an idle machine;
  a full-suite parallel run makes a doubly-nested node bootstrap
  (`feishu run` → print child) take 6s+.

A tighter budget does not make a test stricter — it only converts load into a
false failure at the readiness probe, before the behaviour under test is even
exercised. Genuinely-broken conditions pay the longer budget only when they fail.

## 2. Order events by arrival sequence, not by wall clock

When asserting "nothing happened after point X", compare **monotonic server-side
sequence numbers**, never `Date.now()`.

- Seam: `pollSeqs` / `closeSeqs` in `test/helpers/remote-bridge-fixture.ts`,
  asserted in `test/remote-bridge-core.test.ts` ("no polling after teardown").
- Why: `Date.now()` jumped *backwards* ~2.6s under load in this sandbox. Polls
  recorded before a gateway disconnect got larger timestamps than the disconnect,
  so the clock-based assertion failed while the bridge was behaving correctly.

When adding a time-sensitive assertion to a new fake service, give it the same
monotonic counter. If you replace such an assertion, prove it still fails on a
real violation — inject the bug (e.g. keep the poll loop alive past `close()`),
watch it go red, then revert.

## 3. Harness match windows anchor at the previous match

A PTY harness that advances one action per matched pattern must start the next
search window **after the matched pattern**, not at the end of the read buffer —
and it must never reset the window to the end of the buffer on every iteration.
Both shapes are the same bug from two sides: a pattern that arrives together with
the previous one, or split across two reads, otherwise never matches while the
app has already produced the expected output. The first shape failed CI in
`remote-bridge-stream` ("High-risk Approval guard still applies to
phone-originated turns"); the second also reproduces with a two-read fixture.

- Seam: `runPty` in `test/helpers/remote-bridge-fixture.ts`, with the same fix in
  `interactive-runtime.test.ts`, `release-matrix.test.ts`,
  `automation-workflow.test.ts`, and `reasoning-replay-cli.test.ts` (the last one
  reset its window every iteration, so an awaited pattern only matched when it
  arrived inside a single read).
- Locked by `test/pty-harness.test.ts` (same-read case) and a two-read case in
  `reasoning-replay-cli.test.ts`; both go red against the old window logic.

## Diagnosis notes (why these, not other fixes)

- The 5s budget was not "too tight for a slow machine" in the abstract: bisection
  showed 29 parallel test files green and 58 red, i.e. a load threshold, not one
  interfering file. Instrumentation showed the child was alive and silent
  (`firstExited=false`, empty stderr) — slow, not crashed.
- The clock assertion had three red captures, all with the same signature: a
  decreasing `Date.now()` sequence inside a single-threaded server process.
  The sequence-number version was verified red-capable by injecting a real
  post-teardown poller.
