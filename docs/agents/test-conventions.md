# Test Conventions — Budgets, Matching Windows, and the PTY Harness Contract

This repo tests behaviour through one seam: real CLI subprocesses with a temporary
HOME and fake `lark-cli`/model services (SPEC §"验收"). Two instruments carry the
conventions below — `waitFor` for readiness polling, and the PTY harness for
behaviour that only exists in the interactive/TUI path (confirmation prompts,
`/reload`, `/remote`, streamed cards). Both exist because the suite runs dozens of
spawned children in parallel: a loaded machine, not an idle one.

## 1. Budgets: shared defaults, overrides need a measured reason

Two different budgets — don't conflate them:

- **Readiness poll budget**: `waitFor` in `test/helpers/automation-cli-fixture.ts`,
  300 × 50ms = 15s, shared by ~70 call sites.
- **PTY harness timeout**: `runPty`'s `timeoutSec`, default 60s.

Wait through the shared helper and raise **its one default** instead of passing a
hardcoded millisecond budget at the call site. A tighter budget does not make a
test stricter — it converts load into a false failure at the readiness probe,
before the behaviour under test is exercised. Genuinely-broken conditions pay the
longer budget only when they fail.

An explicit override is allowed only when the test needs more than the default
**and** the number is measured: write the reason and the measurement at the call
site (today's only override is `automation-workflow`'s 90s against a 29s test).
The two 30s literals this replaces were guesses — their tests take 1.3s and 4.2s,
so they now inherit the default.

## 2. Timing: order events by arrival sequence, not by wall clock

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

## 3. The PTY harness contract

`runPty` in `test/helpers/pty-harness.ts` drives a real CLI subprocess in a PTY:
start it, wait for observable output (or external state), send input, and report
the exit code plus everything the child wrote.

**Guarantees**

- Actions are matched **in order**. Each action's search window starts **after the
  previously matched pattern** — never at the end of the read buffer, and never
  reset per loop iteration.
- Action fields: `wait` (substring), `waitFile` (external file must exist),
  `markFile` (create an empty file when the pattern matches), `send`.
- Exit codes: `0` the child ran to completion and exited; `124` the harness timed
  out; `125` the child exited while actions were still outstanding.
- `ignoreCase` folds ASCII case for the whole run; the default is `false`, because
  loosening matching hides real mismatches. (CJK is unaffected by ASCII folding.)
- Callers own failure formatting: the remote bridge fixture still sanitises and
  parses its `PTY_TIMEOUT` diagnostic and attaches the progress snapshot the
  module returns.

**Rules**

- **Upgrade rule**: an interaction protocol earns its place in the module when a
  **second** test needs it. Same protocol twice → promote it, never copy it.
- **Option discipline**: a new option needs a real user, a line in this file, and
  test coverage. Don't grow the module for one caller's convenience.
- **Default posture**: defaults take the widest harmless margin (`timeoutSec` 60,
  not the tightest value that passes) — tightening hides failures, loosening only
  delays a failing run.
- **Single-test scripts**: a PTY script used by exactly one test may stay inline,
  but must carry `// single-test PTY script: not shared`. A guard test in
  `test/pty-harness.test.ts` enforces the label. It cannot detect *true*
  duplication — that isn't mechanically decidable — but it forces the question
  "is this really used once?", which is the cheap gate that stops copy #6.

**Why these rules** — each maps to a real failure: copy-paste made one matcher bug
take five separate fixes; one caller asked for a second exit convention; two 30s
budgets were guesses. See the diagnosis notes below.

**Why not a `lenientExit` option**: one caller wanted the child's own exit code
when the child exits early. That is one caller's convenience, the suite already
used `125` in four places, and a second convention would have invited a sixth
copy. If the numeric code is ever genuinely needed, add a diagnostic line to the
exit path for everyone — never a mode.

**Where domain protocols live**: the module owns PTY mechanics plus "signal on
match" (`markFile`). The lifecycle tests' `.ready`/`.proceed` handshake and
"write the outcome into a marker file" stay in
`test/helpers/automation-cli-fixture.ts`: a file-naming convention for one test
family is not a PTY mechanic.

**The two matcher properties, and their regression tests** — each goes red when
the property is broken:

- **Advance the window only when an action matches.** Resetting it every loop
  iteration leaves only the latest read, so a pattern split across two reads never
  matches. Guarded by the two-read case in `reasoning-replay-cli.test.ts` (red
  against a per-iteration reset — that harness's original bug).
- **Anchor it at the end of the matched pattern.** Advancing it to the end of the
  read buffer drops a pattern that arrives together with the previous one. Guarded
  by `test/pty-harness.test.ts` (red against `checkpoint=len(out)`). This shape
  failed CI in `remote-bridge-stream` ("High-risk Approval guard still applies to
  phone-originated turns"): the guard fired, the model answered, the card opened
  and closed, and only the harness was stuck waiting.

## Diagnosis notes (why these, not other fixes)

- The 5s budget was not "too tight for a slow machine" in the abstract: bisection
  showed 29 parallel test files green and 58 red, i.e. a load threshold, not one
  interfering file. Instrumentation showed the child was alive and silent
  (`firstExited=false`, empty stderr) — slow, not crashed.
- The clock assertion had three red captures, all with the same signature: a
  decreasing `Date.now()` sequence inside a single-threaded server process.
  The sequence-number version was verified red-capable by injecting a real
  post-teardown poller.

## Known load flakes: re-run, don't re-diagnose

A few timing tests can exceed a deliberately short budget when the full suite runs
in parallel on a busy machine. Each passes in isolation, none indicates a product
defect, and **CI has never shown any of them** (the six-job matrix has been green
on every run so far). Local full-suite runs are a reference, not the gate: if one
of these goes red locally, re-run it (or the suite) rather than re-diagnosing.

| Test | Budget | What overload looks like |
|---|---|---|
| `automation-trigger-interval` "overlap-skipped without queuing" | shared 15s `waitFor` | the awaited condition needs 19.7s (measured once, ~1 run in 15) — resolved 2026-09-28: that call site now carries a measured 30s override (`settledOccurrence(..., 600)`); the entry stays for history |
| `remote-bridge-diagnostics` "card open delay 0ms" | 12s, asserted as a 12–15s window | the first turn takes so long that the harness times out on action 0, indistinguishable from the intended stall |

Act only when one of them fails **in CI**, or repeats in consecutive local runs.
Then the levers — in order of preference — are: reduce `--test-concurrency` so the
suite stops oversubscribing the machine, give that call site a measured override,
or make the test load-aware. Do not delete the test: it covers real behaviour
(overlap-skip, timeout diagnostics), and losing it would hide the risk rather than
remove it.
