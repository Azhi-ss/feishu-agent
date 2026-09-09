# Automation tooling: the Agent manages systemd timers itself, but still owns no scheduler process

The Briefing deployment (ADR-0002) is hand-built: the workspace scripts and
systemd units live outside the repository and are installed by copying files
and running a shell script. The Agent cannot create or inspect scheduled jobs;
every new recurring unattended task needs a human to hand-write units. We
studied two agent products that make scheduling a model-facing tool
(OpenClaw Automations, NousResearch Hermes cron) and decided which half of
their design to adopt.

## Decision

Add a management surface, not a daemon. `feishu automation` creates, lists,
runs, pauses, resumes, and removes unattended jobs. The scheduler remains
systemd **user** timers (Linux only); feishu never gains a resident process.
Each job is still a fresh memory-less `feishu -p` print run under
`FEISHU_UNATTENDED=1`, starting in the Automation Workspace so its `AGENTS.md`
standing policy is injected (ADR-0002/0003 unchanged).

A job is: a prompt file, a JSON record (`jobs/<name>/job.json`), a generated
per-job timer unit, and one shared service template that runs a generated
shell launcher. Schedule expressions are systemd `OnCalendar` strings
validated with `systemd-analyze calendar`; the timezone is a separate explicit
parameter (default `Asia/Shanghai`), and `Persistent` catch-up is an explicit
flag. The Agent therefore works with a strict, system-defined schedule
grammar instead of free-form shell.

## Why not copy OpenClaw/Hermes wholesale

- Both keep the trigger **inside a resident gateway daemon** (SQLite/JSON
  store + a 60-second tick loop + job supervision). Feishu deliberately has no
  always-on Runtime; a daemon would reintroduce the long-lived process that
  ADR-0002 rejected, plus restart/logging/supervision code that systemd
  already provides. Their trigger is pluggable (Hermes even externalizes it
  to a managed webhook for scale-to-zero hosts); systemd user timers are our
  trigger provider.
- What is worth copying is the **management and safety UX**, now adopted:
  - the model-facing tool is a verb over a job registry (`automation`),
    mirroring Hermes `cronjob` / OpenClaw `automations`;
  - every run is an isolated fresh session (already our contract);
  - creation requires an explicit human-readable confirmation (TTY prompt, or
    `--yes` for a driven call) — nothing is scheduled behind the owner's back;
  - `--run-now` fires the real job once immediately, the OpenClaw promotion
    pattern ("approve exactly what will arrive"); on failure the job is left
    paused, not silently enabled;
  - a **recursion guard**: inside `FEISHU_UNATTENDED=1` runs all management
    verbs are refused — a scheduled run cannot create or mutate schedules
    (Hermes disables the `cronjob` toolset in cron sessions for the same
    reason). `run` stays available for the systemd-generated launcher;
  - policy and schedule stay separate: the prompt defines *when*, the
    workspace `AGENTS.md` defines *what is authorized* (OpenClaw's
    standing-orders split).

## Consequences

- Availability is unchanged: jobs fire only while the host is up and the user
  manager exists; `Persistent=true` replays a missed fire on next login. The
  tool does not make a laptop always-on — moving the workspace to an
  always-on host remains the availability answer.
- Cross-machine dedupe is not solved here or by the reference products: each
  host schedules independently. Enabling the same job on two hosts sends two
  messages. The discipline stays "enable on one host".
- The hand-built Briefing is not migrated or touched; the generated jobs are a
  parallel mechanism, and importing it is a later optional task.
- The first `automation add` into an empty workspace seeds a default
  standing-policy `AGENTS.md` generalized from the Briefing workspace policy
  (bot → owner 1-on-1 is the only write egress). An existing workspace
  `AGENTS.md` is never overwritten.
- The ADR-0003 upgrade trigger is unaffected but now applies to a larger
  surface: every generated job relies on prompt-level guards. General jobs
  with broader write authority than the owner digest should not be created
  before the hard unattended command policy exists.
- v1 is Linux/systemd only. macOS (launchd) and hosts without a user manager
  fail fast with an actionable error rather than a half-installed job.
