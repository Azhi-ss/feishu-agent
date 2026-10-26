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

- Seam: `pollSeqs` / `closeSeqs` / `arrivals` in
  `test/helpers/remote-bridge-fixture.ts`, asserted in
  `test/remote-bridge-core.test.ts` ("no polling after teardown"; `arrivals`
  stamps each inbound event with the server's monotonic seq, so a batch's
  arrival order can be compared to the bridge's injection order).
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

## 4. Loopback fake: inject outbound card failures and hangs

The loopback fake Feishu service (`test/helpers/remote-bridge-fixture.ts`) records
outbound calls and can be told to fail or hang leading calls per card endpoint:

- `outboundFailures: { cardOpen?, cardAppend?, cardClose?, sendMessage? }` — the
  leading N calls per endpoint answer HTTP 500; `Infinity` fails every call.
- `hangOutbound: { cardOpen?, cardAppend?, cardClose?, sendMessage? }` — the
  leading N calls per endpoint never get a response; `Infinity` hangs every call.
  The fake deliberately supplies no timeout of its own: the hang is only survivable
  if the client bounds the wait. Recorded in `stats.hangs` (`{ endpoint, at }`),
  which is the evidence that the hung call actually reached the wire.
- Both injections fire before the wire write, so `cards.opened/appends/closes` and
  `sends` keep meaning "wire writes the server actually served" — a failed or hung
  open leaves `opened` empty, and a failed or hung plain message never appears in
  `sends`.
- `markCardClosed(path)` writes the marker once a successful close is served, so a
  test can synchronise on finalization through `waitFile` instead of reaching into
  the fake server's request events (same protocol for every card-delivery test).
- Real user: the Remote Bridge delivery-fallback tests in
  `remote-bridge-core.test.ts` (card open/append/close failure, bounded close
  retry, a plain-message fallback that cannot land, and the hung-close /
  hung-append / hung-open cases that need the outbound budget), with the
  state-machine half covered in `stream-card.test.ts` and the budget itself in
  `remote-gateway.test.ts`.
- The budget those tests inject is the one shared default
  (`FEISHU_REMOTE_OUTBOUND_TIMEOUT_MS`), never a millisecond literal at the
  bridge call site: a smaller value is the only test-side change.
- `warningThenQuit(warning)` is the family's shared PTY script (handshake → the
  expected warning → `/remote status` answering → `/quit`): the delivery-failure
  and hung-outbound tests use it instead of copying those four actions.

## Diagnosis notes (why these, not other fixes)

- The 5s budget was not "too tight for a slow machine" in the abstract: bisection
  showed 29 parallel test files green and 58 red, i.e. a load threshold, not one
  interfering file. Instrumentation showed the child was alive and silent
  (`firstExited=false`, empty stderr) — slow, not crashed.
- The clock assertion had three red captures, all with the same signature: a
  decreasing `Date.now()` sequence inside a single-threaded server process.
  The sequence-number version was verified red-capable by injecting a real
  post-teardown poller.

## Full-suite file concurrency: the first remedy for a red local run

`npm test` runs `node --test dist/test/*.test.js` at Node's **default file
concurrency** — `availableParallelism() - 1` file slots, so 19 of the 66 files in
flight at once here — and each file spawns its own children. That self-inflicted
oversubscription makes the whole suite both red and *slower*; it is the same
load-threshold class as the 5s-budget bisection in the diagnosis notes above.
Measured 2026-10-26 on this box (the bounded-concurrency row predates the
post-recovery row, hence 397 vs 401 tests):

| Run | Result | Wall clock |
|---|---|---|
| `npm test` (default concurrency), 4 attempts in the red window | red: 9 / 14 / 18 / 19 failures, all `condition was not met before timeout` on the shared 15s `waitFor` or PTY exit `124`, in `automation-trigger-*`, `automation-service`, `automation-package` and startup tests | 383–660s |
| `node --test --test-concurrency=6 …` | red: 3 failures, same class | 661s |
| `node --test --test-concurrency=4 …` | **green: 397 tests, 393 pass, 0 fail, 4 skipped** | **138s** |
| `automation-trigger-interval` + `automation-trigger-cron` sequentially | green 12/12 | 19.7s |
| `automation-service` + `automation-package` sequentially | green 12/12 | 20.4s |
| literal `npm test` (default concurrency), later quiet run | **green: 401 tests, 397 pass, 0 fail, 4 skipped** | **105s** |

The failing set is different on every run and each of those files passes in
isolation, so no individual test is broken; the default is both flakier and
2.8–4.8× slower than bounded concurrency (383–660s vs 138s). The overload is the
suite's own file parallelism, not an external benchmark: 20 cores, and during a
red run `vmstat` showed 100% idle, run queue 0, `/proc/pressure/*` ~0, no
containers and no leftover test children. Nor is it a product regression: it
reproduced at a 386-test scope with the newer test files removed, and none of the
failing families were touched by recent work.

These are **host-contention flakes, not product regressions**: the fix is lower
file concurrency, never a wider per-test budget at the call site.

**When a local full suite goes red this way:**

1. Re-run it — the single file, or the suite. Green on the re-run means this class.
2. If it repeats, bound file concurrency explicitly:
   `npm run build && node --test --test-concurrency=4 dist/test/*.test.js`. For
   this class the fix is the flag, not a budget: do **not** edit `package.json`'s
   `test` script. What expires is the shared 15s `waitFor`, the 12s window
   `remote-bridge-diagnostics` asserts, or the PTY harness `timeoutSec` under
   load — not a condition that needs more time. §1 still allows a genuinely
   measured override, but a full-suite load failure is not one: a wider budget
   would slow every genuine failure and hide the concurrency problem instead of
   fixing it.
3. Only a failure that is **reproducible in CI**, or that repeats at bounded
   concurrency, is a real regression to diagnose.

CI's three-job matrix has never shown these failures, so this is (at least) a
local-runs concern; a local full-suite run is a reference, not the gate.

## Known load flakes: instances of the class above

Both rows below are the same oversubscription class, already explained by the
section above: the shared `waitFor` default or the PTY harness expiring while the
whole suite runs in parallel. Each passes in isolation, none indicates a product
defect, and CI has never shown either. If one goes red locally, apply the remedy
above — re-run, then `--test-concurrency=4` if it repeats. Row 1's 30s override
was a measured exception added 2026-09-28 (`settledOccurrence(..., 600)`), not a
precedent for widening a budget for the class above.

| Test | Budget | What overload looks like |
|---|---|---|
| `automation-trigger-interval` "overlap-skipped without queuing" | shared 15s `waitFor` | the awaited condition needs 19.7s (measured once, ~1 run in 15) — resolved 2026-09-28: that call site now carries a measured 30s override (`settledOccurrence(..., 600)`); the entry stays for history |
| `remote-bridge-diagnostics` "card open delay 0ms" | 12s, asserted as a 12–15s window | the first turn takes so long that the harness times out on action 0, indistinguishable from the intended stall |

Act only when one of them fails **in CI**, or repeats at bounded concurrency. Do
not delete the test: it covers real behaviour (overlap-skip, timeout diagnostics),
and losing it would hide the risk rather than remove it.
