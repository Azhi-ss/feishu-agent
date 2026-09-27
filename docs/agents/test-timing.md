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

Five test files drove a PTY with their own copy of the same embedded Python, so one
harness bug had to be fixed five times and a sixth would have been written by
copy-paste. The driver now lives in one module:

- `runPty` in `test/helpers/pty-harness.ts`, whose options cover the union the
  callers need (`timeoutSec`, `cliPath`, `killAfterLastActionSec`, `diagnostics`,
  `resend`). Callers keep their own failure formatting — the remote-bridge fixture
  still sanitises and parses its `PTY_TIMEOUT` diagnostic, and captures the
  progress snapshot the module hands back.

Two properties keep the matcher honest. Each has a regression test that goes red
when it is broken:

- **Advance the search window only when an action matches.** Resetting it on every
  loop iteration leaves only the latest read in the window, so a pattern split
  across two reads never matches. Guarded by the two-read case in
  `reasoning-replay-cli.test.ts` (red against a per-iteration reset, which was that
  harness's original bug).
- **Anchor it at the end of the matched pattern.** Advancing it to the end of the
  read buffer drops a pattern that arrives together with the previous one. Guarded
  by `test/pty-harness.test.ts` (red against `checkpoint=len(out)`). This shape
  failed CI in `remote-bridge-stream` ("High-risk Approval guard still applies to
  phone-originated turns"): the guard fired, the model answered, the card opened and
  closed, and only the harness was stuck waiting.

The five flag-based harnesses (`automation-cli-fixture`, `automation-trigger-lifecycle`,
`automation-cli-lifecycle`, `high-risk-approval`, `memory-degradation`) match against
the whole buffer with a `sent`/`replied` latch and do not share this failure mode.

## Diagnosis notes (why these, not other fixes)

- The 5s budget was not "too tight for a slow machine" in the abstract: bisection
  showed 29 parallel test files green and 58 red, i.e. a load threshold, not one
  interfering file. Instrumentation showed the child was alive and silent
  (`firstExited=false`, empty stderr) — slow, not crashed.
- The clock assertion had three red captures, all with the same signature: a
  decreasing `Date.now()` sequence inside a single-threaded server process.
  The sequence-number version was verified red-capable by injecting a real
  post-teardown poller.
