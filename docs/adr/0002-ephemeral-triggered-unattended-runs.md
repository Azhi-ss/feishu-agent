# Unattended automation uses ephemeral print runs with an external trigger

> Managed Automation Jobs retain the fresh-run/no-Mem0 principle below.
> [ADR-0005](0005-cross-platform-automation-trigger.md) and SPEC §16.5 replace
> the original systemd-only trigger with a separate application scheduler and
> a managed workspace distinct from the deployed Briefing. The deployment
> details below remain historical context, not requirements for new jobs.

Unattended automation (the daily Briefing, and later the periodic Sweep) needs to
do work when the user is not sitting at the TUI. We decided that the always-on
component is only an external **Trigger** (a systemd user timer now; an event
watcher later), and that each automation run is a **fresh, short-lived
`feishu -p` print run** that exits when its turn finishes. There is no
long-lived Feishu Runtime holding model context overnight.

Why:

- **Restartability beats continuity for unattended systems.** Any run must be
  killable at any time without losing state. Persistent state lives only in
  Feishu itself (source of truth), the workspace files (policy, run traces,
  sweep cursors), and interactive Mem0 memory — never in a sleeping agent's
  context.
- A multi-day-old context is stale, has been compacted unattended, and fails
  opaquely. A fresh run loads the current workspace instructions and pulls
  current facts every time.
- Spontaneity from an always-on brain is an unattended hazard, not a feature.
  Timing is decided by the Trigger; the run only executes defined policy.

Unattended runs are started with `FEISHU_UNATTENDED=1`, which makes the process
**memory-less**: the Mem0 extension is not registered (no recall, no capture,
no dream), so no API key is required and automation content—including raw
group-chat and at-mention text—can never be learned into any bucket.
Personalization lives in the workspace `AGENTS.md`, which is human-readable,
reviewable policy instead of learned behavior.

All unattended runs start in a dedicated non-git **Automation Workspace**
(`~/feishu-automation/`), deliberately outside the disposable
`~/.feishu-agent/` Agent Home. The workspace owns its (unused) memory bucket,
session partition, policy file, `briefings/` traces (retained 30 days), and
`.state/` cursors. Trigger scripts are host-neutral so the workspace can move
to an always-on host later; the workspace path must not be renamed or moved
once created (the memory bucket and session partition hash the absolute path).

## Considered Options

- **One long-lived interactive Runtime, 24/7** (rejected): the Remote Bridge
  already shows that sessions go stale and runners must be re-established —
  tolerable with a human watching the TUI, unacceptable unattended. It also
  accumulates context and cost with no audit boundary.

- **Cron/systemd spawning ephemeral print runs** (chosen): auditable (one
  prompt, one transcript per run), and trivially disabled by stopping one
  timer. A later scheduled occurrence may proceed after failure; it is not a
  guarantee of replaying a failed occurrence or exactly-once delivery.

## Consequences

- The scheduler is a systemd **user** timer on the owner's WSL box
  (`Persistent=true`, `Linger` not required): a missed weekday 08:30 Briefing
  is caught up on login only before an 11:00 cutoff; after that the stale
  "good morning" is skipped and a manual run remains available.
- No secret is injected into the timer environment: no `MEM0_API_KEY`; model
  credentials are read-only reused from `~/.pi`; `lark-cli` manages its own
  tokens. Bot delivery stays available when the user token needs re-login, and
  such a failure is delivered as a bot notice rather than silent absence.
- Real-time at-mention monitoring is explicitly not in v0: the bot is added to
  no chat, and Sweep polls with the owner's user identity (30-minute target
  cadence). Promoting one group to real-time later is a per-group decision.
- Host availability is bounded to when the WSL box is up; this is accepted
  because the Feishu mobile client remains the native out-of-hours channel.
