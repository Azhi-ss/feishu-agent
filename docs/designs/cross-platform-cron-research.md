# Research: Cross-platform cron for ephemeral Feishu runs

## Summary

The macOS/Linux objection is valid: **systemd-only is a product scope decision, not a requirement of fresh unattended agent runs.** OpenClaw and Hermes normally use **application-level schedulers, not users' OS crontabs**; their background timing machinery is distinct from the model sessions it launches. Both native crontab management (A) and an explicitly enabled, shared application scheduler (B) are feasible for Feishu, but neither makes a sleeping laptop or stopped WSL instance available.

This is research, **not a replacement decision for ADR-0004**. Proposal B preserves ADR-0002's fresh-run principle while revising ADR-0004/§16.5's stronger prohibition on a resident Feishu process.

## Scope and provenance

- Local context read: ADR-0002, ADR-0004, `docs/agents/capability-layering.md`, and SPEC §16 (including §16.5). Repository baseline `f3d0361` is supplied by the task, not independently verified by a git command.
- “Open Cloud” is interpreted as **OpenClaw**, as requested.
- Three varied discovery queries covered OpenClaw scheduling/storage, Hermes source/tick/webhook, and Hermes platform operation. Important findings below come from fetched official docs and source, not search summaries.
- GitHub's `commits/main` responses identified OpenClaw [95ee88474d1887a73803f649457a9f04c231262d](https://github.com/openclaw/openclaw/commit/95ee88474d1887a73803f649457a9f04c231262d) (commit timestamp `2026-09-02T12:16:39Z`) and Hermes [ead7e91dabf1e963796ec834b196984a2fa44ff4](https://github.com/NousResearch/hermes-agent/commit/ead7e91dabf1e963796ec834b196984a2fa44ff4) (`2026-09-09T12:29:21Z`). These are **returned snapshots, not a guarantee of live latest HEAD or release versions**. Most source citations below are pinned to them; public docs are unversioned retrievals. No trusted wall-clock retrieval timestamp was exposed by the tools.
- Exception: Hermes `scheduler_provider.py` was retrievable only through its **moving `main` raw URL**. Its pinned URL returned HTTP 429; the GitHub HTML alternative exposed metadata only, and the contents API reported rate-limit exhaustion. Its content is explicitly marked unpinned below.
- `source_check` was invoked on the decisive architecture comparison, but returned **unclear, confidence 0.30**, retrieving mostly unrelated SQLite issues rather than the already fetched files. Therefore validation rests on direct inspection, not on that automated check. No product was installed or run; no credentials, user crontab, or systemd state were inspected.

## Findings

### 1. What actually owns time and must stay alive?

**Claim:** Neither reference's normal “cron” feature means installing a per-job OS crontab entry. **Support: direct evidence. Confidence: high.**

| | OpenClaw | Hermes |
|---|---|---|
| Default timing owner | Gateway process; JS scheduler | Gateway's background scheduler thread/provider |
| Timing mechanism | `armTimer()` computes next due delay and calls `setTimeout`; delay is capped for minute-level maintenance | `InProcessCronScheduler.start(... interval=60)` calls `cron_tick(... sync=False)`, then waits; exceptions are caught and recorded |
| Liveness | Gateway must be running, scheduler enabled, host awake | Built-in ticker must be running and healthy, host awake; simply creating a job in a terminal is not enough |
| Model relationship | Scheduler itself is not a model; multiple execution/session styles | Each normal agent-backed fire constructs a fresh `AIAgent`; scripts can bypass the model |
| OS service role | launchd/systemd supervise **one gateway**, not each cron job | launchd/systemd supervise **one gateway**, not each cron job |

Decisive OpenClaw quote: **“Automations run inside the Gateway process, not inside the model. The Gateway must be running for schedules to fire.”** [Official runtime docs](https://docs.openclaw.ai/automation/cron-jobs/how-it-works). Source: [`armTimer`, `setCronTimer`](https://github.com/openclaw/openclaw/blob/95ee88474d1887a73803f649457a9f04c231262d/src/cron/service/timer-scheduler.ts): **“Wake at least once a minute”**, with `Math.min(flooredDelay, MAX_CRON_TIMER_DELAY_MS)`. This is **not a fixed 60-second polling loop**.

Hermes: [official cron docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron/), pinned [`gateway/run.py`](https://github.com/NousResearch/hermes-agent/blob/ead7e91dabf1e963796ec834b196984a2fa44ff4/gateway/run.py) symbols `_start_gateway_start_cron_and_housekeeping`, `_start_cron_ticker`; [unpinned provider implementation](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/cron/scheduler_provider.py) says **“Default in-process 60s ticker”**. The pinned gateway's old ticker function is a deprecated shim delegating to `InProcessCronScheduler`.

### 2. Schedule language, timezones, persistence, and run isolation

**Claim:** Both offer a richer application job model than portable native crontab, but their exact grammars and isolation defaults differ. **Support: direct evidence, with qualifications below. Confidence: high.**

| Dimension | OpenClaw | Hermes |
|---|---|---|
| Calendar expressions | 5- or 6-field cron via `croner`; DOM/DOW OR semantics, plus parser extensions | `parse_schedule` passes expressions to `croniter`; source comment says 5–6 fields, but guard actually accepts ≥5 before parser validation. Do not assume identical six-field syntax to OpenClaw |
| Timezone | Per-job IANA `--tz` for cron and offset-less `at`; cron defaults to gateway host zone; offset-less timestamp defaults UTC without `--tz` | Configured profile clock: `HERMES_TIMEZONE` → `timezone` config → host local. Naive ISO timestamps attach this zone at parse time. No verified per-job IANA timezone parameter in the inspected parser/tool |
| One-shot | `at`, ISO or relative CLI duration; delete after successful whole-run completion by default | `once`, ISO timestamp or `in 30m`; finite repeat counts supported. Creation/resume reject one-shots >120 seconds in the past |
| Intervals | `every`, e.g. `10m`, `1h`, `1d`; distinct from cron calendar fields | `every 30m` and **bare `30m` are recurring**, not one-shot; also some natural weekly/daily forms |
| Timing precision | Due-time timer, but top-of-hour recurring cron is staggered up to five minutes unless `--exact`/explicit stagger policy | Default ticker roughly minute cadence, not second-accurate dispatch even if parser accepts seconds |
| Durable jobs | Shared SQLite state database at fetched version; legacy JSON migration exists | `~/.hermes/cron/jobs.json`; outputs in `cron/output`; separate `cron/executions.db` execution ledger |
| Fresh context | `isolated` produces a new transcript/session ID each run; **not all modes are isolated** | New `AIAgent` per normal run; optional skills/prefill/`continuity` can inject previous outputs |

Sources: OpenClaw [schedules](https://docs.openclaw.ai/automation/cron-jobs/schedules), [`schedule.ts`](https://github.com/openclaw/openclaw/blob/95ee88474d1887a73803f649457a9f04c231262d/src/cron/schedule.ts), [payloads](https://docs.openclaw.ai/automation/cron-jobs/payloads), [`store.ts`](https://github.com/openclaw/openclaw/blob/95ee88474d1887a73803f649457a9f04c231262d/src/cron/store.ts). The latter opens **“Public cron store load/save API backed entirely by shared SQLite state.”** A remaining `jobs.json` path helper identifies a legacy/store partition; it does not establish current JSON persistence.

Hermes: [cron docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron/), [`parse_schedule`, `compute_next_run`, `ONESHOT_GRACE_SECONDS` in jobs.py](https://github.com/NousResearch/hermes-agent/blob/ead7e91dabf1e963796ec834b196984a2fa44ff4/cron/jobs.py), [`hermes_time.py`](https://github.com/NousResearch/hermes-agent/blob/ead7e91dabf1e963796ec834b196984a2fa44ff4/hermes_time.py), [`_construct_cron_agent` in scheduler.py](https://github.com/NousResearch/hermes-agent/blob/ead7e91dabf1e963796ec834b196984a2fa44ff4/cron/scheduler.py).

**Important distinction:** a fresh session is not necessarily a fresh OS process, nor “memory-less.” OpenClaw offers `main`, `current`, `isolated`, and persistent custom sessions. Hermes can inject continuity. Feishu's separate `FEISHU_UNATTENDED=1 feishu -p` subprocess and omitted Mem0 extension are a stronger, independently retained contract.

### 3. Missed runs, overlap, failure, and retry

**Claim:** Neither product reduces reliability to “run every minute”; durable claims, missed-run policy, concurrency, and failure accounting are substantial parts of the implementation. **Support: direct evidence. Confidence: high for cited behavior; no end-to-end verification.**

**OpenClaw**

- Recurring offline catch-up defaults on; `cron.skipMissedJobs: true` advances recurring schedules instead. One-shots have separate recovery semantics. Startup overdue isolated agent turns are **deferred/rescheduled**, not all replayed during channel connection.
- Startup/restart recovery tracks durable run receipts and owner identity. It cannot undo external side effects already sent. Catch-up is paced, not an assurance that every missed slot is replayed.
- Timer admission reserves due jobs, retains capacity-blocked work, and wakes when slots free. Shared admission is bounded by `DEFAULT_CRON_MAX_CONCURRENT_RUNS`; the fetched `resolveRunConcurrency()` returns that constant, so do not promise an old configurable concurrency contract without checking the target version.
- Transient one-shot failures have built-in retries; permanent errors disable. Recurring execution-error backoff is documented as 30s, 60s, 5m, 15m, 60m, reset after success.
- Delivery-only failure is distinguished from execution error: it does not enter execution backoff. Uncertain send identity is recorded `unknown`, not automatically resent. Successful execution alone does not necessarily delete a one-shot whose required delivery failed.

Sources: [runtime/recovery](https://docs.openclaw.ai/automation/cron-jobs/how-it-works), [management/retries](https://docs.openclaw.ai/automation/cron-jobs/managing-jobs), [`timer-catchup.ts`](https://github.com/openclaw/openclaw/blob/95ee88474d1887a73803f649457a9f04c231262d/src/cron/service/timer-catchup.ts), [`timer-scheduler.ts`](https://github.com/openclaw/openclaw/blob/95ee88474d1887a73803f649457a9f04c231262d/src/cron/service/timer-scheduler.ts), [`run-admission-capacity.ts`](https://github.com/openclaw/openclaw/blob/95ee88474d1887a73803f649457a9f04c231262d/src/cron/service/run-admission-capacity.ts), [`timer-outcomes.ts`](https://github.com/openclaw/openclaw/blob/95ee88474d1887a73803f649457a9f04c231262d/src/cron/service/timer-outcomes.ts).

**Hermes**

- Current `get_due_jobs()` explicitly **collapses recurring backlog but still fires once now**. `_fast_forward_missed_recurring` says: **“skip the accumulated misses, fire once now.”** Older issue reports and the helper's older-sounding grace comment must not be used to claim all stale recurring work is simply dropped today.
- Grace calculation remains half a period clamped to 120s–2h. One-shots are materially different: `_retire_expired_oneshot` retires never-fired, unclaimed one-shots beyond **120s**, with a diagnostic. A sleeping laptop can therefore miss a one-shot permanently.
- A `.tick.lock`, durable dispatch/fire claims, and per-job `try_register_running_job` prevent competing local dispatches. The provider uses `sync=False` and persistent worker pools, so model work need not block the next tick. `cron.max_parallel_jobs`/`HERMES_CRON_MAX_PARALLEL` provide limits; workdir-sensitive execution has additional serialization.
- Recurring `next_run_at` advances **before** execution to avoid immediate crash-loop replay. Execution ledger entries left interrupted become `unknown`, **not automatically retried**. Subsequent scheduled occurrences still run. In-call provider recovery is distinct from retrying an entire cron occurrence; no uniform OpenClaw-style whole-job exponential retry ladder was verified.

Sources: [`jobs.py`](https://github.com/NousResearch/hermes-agent/blob/ead7e91dabf1e963796ec834b196984a2fa44ff4/cron/jobs.py), [`scheduler.py`](https://github.com/NousResearch/hermes-agent/blob/ead7e91dabf1e963796ec834b196984a2fa44ff4/cron/scheduler.py), [execution history/storage docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron/), [unpinned provider](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/cron/scheduler_provider.py).

**Researcher inference:** Feishu should choose explicit skip/coalesce/cutoff and overlap semantics rather than inherit either implementation accidentally. Neither claims protocol proves exactly-once Feishu message delivery across a crash after sending.

### 4. Model-facing management and external ticking

**Claim:** Their reusable idea is a structured job-management surface plus deterministic execution, not an always-thinking agent. **Support: direct evidence. Confidence: high.**

- **OpenClaw:** model tool `automations`, legacy `cron` alias; CLI `openclaw automations` with `cron` alias. List/get/create-edit/enable-disable/remove/run/history are exposed. The tool implementation is [`cron-tool.ts`](https://github.com/openclaw/openclaw/blob/95ee88474d1887a73803f649457a9f04c231262d/src/agents/tools/cron-tool.ts); [official management docs](https://docs.openclaw.ai/automation/cron-jobs/managing-jobs) distinguish creator management from authenticated administrator authority. Do not infer that Feishu's exact TTY/`--yes` gate is copied verbatim.
- **Hermes:** `cronjob` structured tool and `hermes cron`/`/cron`, supporting create/list/update/pause/resume/remove/run and diagnostics. [`cronjob_tools.py`](https://github.com/NousResearch/hermes-agent/blob/ead7e91dabf1e963796ec834b196984a2fa44ff4/tools/cronjob_tools.py). `_resolve_cron_disabled_toolsets` disables cron scheduling **by default**, but `cron.allow_agent_scheduling: true` lifts it. This is loop prevention, explicitly **not a security boundary**. Feishu may keep its stricter recursion rule.
- **External tick is real:** official Hermes docs list `hermes cron tick`; pinned `tick()` describes gateway versus standalone/manual tick. An external invoker still must execute it on an awake host; it is not a scheduler by itself.
- **External provider/webhook is real, but qualified:** pinned gateway code resolves a `CronScheduler` provider and has external-provider misfire housekeeping. The fetched unpinned provider defines `fire_due` as **“inbound fire webhook entry”**, claims before `run_one_job`, and falls back to built-in when a provider is missing/failing/unavailable. Official docs describe **platform scheduler → dashboard → gateway internal API**, with missed hand-offs recorded as `last_fire_error`.
- **Not verified:** a complete bundled managed provider/deployment that wakes a scale-to-zero host. The inspected core seam does not prove scale-to-zero capability or that a webhook removes the need for a reachable/wakeable executor. Outbound delivery webhooks and inbound schedule triggers are different features.

Sources: [Hermes cron docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron/), pinned [`gateway/run.py`](https://github.com/NousResearch/hermes-agent/blob/ead7e91dabf1e963796ec834b196984a2fa44ff4/gateway/run.py), [unpinned provider](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/cron/scheduler_provider.py).

### 5. Actual macOS/Linux/WSL constraints

**Claim:** Application scheduling shares timing semantics across macOS and Linux, but service lifecycle and host availability remain platform concerns. **Support: direct evidence plus labeled implications. Confidence: high.**

- OpenClaw explicitly supports macOS LaunchAgent and Linux/WSL2 systemd user-service installation. Hermes documents launchd on macOS and systemd user/system services on Linux. These are **supervision adapters**, not evidence that the schedule grammar is systemd or launchd. [OpenClaw platforms](https://docs.openclaw.ai/platforms), [Hermes gateway](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/).
- Hermes documents lingering for Linux logout persistence, and a macOS plist whose PATH is captured at installation and must be refreshed after tool installation changes. **Implication:** Feishu must handle absolute executable paths, workspace cwd, a controlled noninteractive environment, permissions, logs, and login/logout scope under either proposal; shell init files cannot be assumed.
- Apple's archived official guide acknowledges both cron and launchd but prefers launchd. It explicitly warns against programmatically modifying crontab because it is shared state. That is a design caution, **not proof crontab management is impossible**. It also states sleeping/offline cron jobs are skipped until the next designated time; `StartCalendarInterval` launchd jobs catch sleep-time misses on wake, not powered-off misses. [Apple guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html). This archived guide is not contemporary macOS acceptance testing.
- Native cron is implementation-dependent on Linux. The fetched Cronie manual specifies five fields, minute scans, DOM/DOW OR, and DST missing/repeated-time behavior. `*/35` means minutes 0 and 35, **not every 35 elapsed minutes**. Do not extend Linux `CRON_TZ` support to macOS without testing its cron implementation; setting a child's `TZ` alone does not establish scheduler timezone support. [Cronie manual](https://man7.org/linux/man-pages/man5/crontab.5.html).
- WSL supports systemd in suitable versions/distributions, but Microsoft says **“systemd services will NOT keep your WSL instance alive.”** Cron inside a stopped distro cannot fire either. This is an availability boundary, not an argument for or against cron grammar. [Microsoft WSL systemd](https://learn.microsoft.com/en-us/windows/wsl/systemd).

## Corrections to the local ADR rationale

These are research findings only; no ADR or SPEC edits were made.

| Existing statement | Verified correction |
|---|---|
| Both have “SQLite/JSON + a 60-second tick” | Current OpenClaw: SQLite and adaptive next-due timer with minute watchdog. Hermes: JSON jobs, SQLite execution ledger, default 60s provider loop. Name each separately and version the claim. |
| Gateway daemon implies a long-lived model Runtime/context | Timing process and model context are separate. ADR-0002 rejects retained sleeping agent context; that does not by itself rule out a zero-model scheduler process. ADR-0004 adds a stricter process prohibition. |
| Every reference run is fresh | True for chosen isolated modes, false as a universal statement about OpenClaw. Hermes also offers explicit output continuity. |
| Hermes cron cannot manage cron | Default only; current source has an opt-in override. Feishu need not copy it. |
| Hermes webhook supports scale-to-zero | Provider/fire seam verified; actual managed wake/scale-to-zero infrastructure not verified. |
| References do not solve any cross-machine dedupe | Too categorical: Hermes provider interface mentions store CAS claims across machines; OpenClaw tracks foreign owner receipts. Independent local homes on two hosts still do not dedupe automatically, so Feishu's one-active-host discipline remains appropriate. No tested distributed guarantee established here. |
| A built-in daemon necessarily violates zero-network/zero-blocking startup | Not inherently: an explicit separate scheduler entry/service can remain entirely outside Interactive/Print/init startup. Automatically starting/waiting for it there would be a different, prohibited design. |
| Next trigger is a “retry” | A later scheduled occurrence is not necessarily a replay of a failed occurrence. The distinction affects delivery and missed-run expectations. |

## Two feasible proposals — decision not yet made

The model-facing interface and unattended execution contract can be the same under either option. Neither needs a chat gateway, remote API, new memory system, or long-lived model session.

| Decision dimension | A — Manage native user crontab | B — Shared application scheduler |
|---|---|---|
| Timing owner | Existing OS cron daemon reads Feishu-owned entries | One explicitly installed lightweight timing process; or externally invoked deterministic `tick` |
| Cross-platform baseline | macOS/Linux common five-field calendar subset; cron must exist and run | Same parser and semantics on both OSes; OS only supervises process/tick invoker |
| Runner | Each entry invokes shared runner → fresh `FEISHU_UNATTENDED=1 feishu -p` | Due-job dispatch invokes the same fresh subprocess contract |
| Minimal appeal | No resident Feishu process, least new scheduling code | One job language/timezone/catch-up policy, natural one-shots and true intervals |
| Main cost | Shared crontab ownership/update conflicts, quoting/environment, platform differences | Durable registry/claims, next-run computation, timer lifecycle, failure recovery and supervision |
| Missed time | Plain cron skips offline slots; cutoff can reject stale work but cannot create a missing invocation | Explicit skip or coalesced catch-up with cutoff on restart/wake; define one-shot expiry |
| Overlap/retry | Runner must add locks, deadlines and status; cron alone does not provide application retries | Scheduler/runner must deliberately implement the same contracts; do not import reference complexity wholesale |
| Timezone | Portable per-job IANA scheduling is a gap; host-local first is simplest but differs from SPEC's explicit Asia/Shanghai | Explicit per-job IANA evaluation is feasible; DST/clock-change behavior must be tested |
| Lifecycle | User enables owned entries; no daemon Feishu owns | Explicit opt-in service install/start, separately supervised by launchd/systemd; external tick variant avoids resident Feishu but still needs an invoker |
| ADR impact | Revises Linux/systemd backend and OnCalendar language, preserves “no resident Feishu” | Revises backend/language **and ADR-0004's no-resident-process rule** for daemon variant; preserves fresh-run/no-Mem0 principle |

**A is viable if** the immediate need is a few minute-resolution, host-local calendar jobs and skipping sleep/offline misses is acceptable. Keep prompts in files, managed entries visibly delimited, preserve unrelated entries, and detect concurrent modifications. Treat Apple's warning seriously. Do not advertise one-shots, arbitrary elapsed intervals, portable IANA zones, or systemd-like catch-up as native cron features.

**B is viable if** consistent macOS/Linux scheduling, explicit per-job zones, one-shots/intervals, and controlled wake/restart catch-up are real requirements. A timer-only Node process is not an always-on brain: no SDK/model session until a child run is due. Keep service installation and health checks opt-in, outside normal startup; no automatic networking or service wait in Interactive/Print/init.

**External-tick variant of B:** one native `* * * * *` entry (or equivalent external trigger) invokes the common application `tick`, which reads state and decides what is due. That is **application-level scheduling with an OS pulse**, not proposal A's per-job native scheduling. It trades a resident timing process for minute granularity and process startup overhead; it still needs durable claims and missed-run semantics. Do not build both timer and external-tick variants before a concrete deployment need.

**Shared minimum acceptance contract, whichever is selected:** explicit creation confirmation; no job mutation from unattended model runs; one run path for scheduled/manual execution; no Mem0 or copied secrets; prompt/cwd/resource isolation; clear logs/status and bounded execution; same-job overlap policy; deliberate crash/delivery ambiguity handling; no automatic two-host activation. Preserve the independent ADR-0003 authorization upgrade gate—changing the scheduler does not strengthen prompt-only write policy.

## Contradictions and uncertainty

- OpenClaw search results strongly reflected older JSON-based cron. Current fetched docs and pinned source agree on SQLite; old summaries were not used as final evidence.
- Hermes old issue reports describe a tick lock held across long runs and dropped stale jobs. Current source uses asynchronous dispatch and coalesced catch-up. The reports are useful historical warnings, not current behavior claims.
- Hermes documentation's general “past-due jobs on next tick” statement omits the pinned source's strict 120s one-shot expiration. The implementation is decisive for that edge case.
- The fetched docs and source are not guaranteed the same release. Example: Hermes docs describe model selection as per-job → fleet → global, while pinned scheduler source adds creation snapshots. This is outside the scheduler choice, but demonstrates why exact release pinning matters.
- Native cron behavior on the user's actual macOS/Linux installations, macOS privacy controls, DST transitions, WSL suspension, and provider external-fire recovery have **not** been tested. No universal exactly-once or availability guarantee is inferred.

## Sources kept / deprioritized

**Kept:** official OpenClaw automation/platform docs and pinned `src/cron`/tool files; official Hermes cron/gateway docs and pinned `cron/jobs.py`, `cron/scheduler.py`, gateway/tool/time files; unpinned provider source with explicit provenance caveat; Apple platform guide, Cronie manual, and Microsoft WSL docs. Inline URLs identify the evidence for each decision-relevant claim.

**Rejected/deprioritized:** OpenClawCN mirror and third-party OpenClaw tutorials/debug blogs (secondary and often pre-SQLite); GitHub issue anecdotes about old Hermes starvation (not current source); source-check's unrelated node:sqlite issues (not scheduler evidence). Guessed OpenClaw `/scheduling` and `/reference` child paths returned 404; the actual linked `/schedules` and `/managing-jobs` pages were fetched successfully.

## Next steps for the design conversation

1. Settle the real requirement first: **portable daily/weekly cron with skipped offline runs**, or **uniform per-job timezones + one-shots/elapsed intervals + explicit catch-up**? This determines whether A stays genuinely smaller or turns into B hidden in shell wrappers.
2. Separately confirm whether an explicitly enabled **timer-only background process** is acceptable. Do not conflate it with retaining model context. If it is acceptable and richer semantics are required, B is a credible alternative to revisit in ADR-0004—not an implementation approval in this report.
3. Once a direction is selected, pin a minimal behavior contract and validate only its platform edges on temporary fixtures (no real schedules): next-fire/DST, sleep/restart/coalescing, overlap/manual-run races, child timeout, failed/ambiguous delivery, normal startup with no scheduler activity. Retrieve a pinned Hermes provider implementation only if the external-provider path becomes a real requirement.
