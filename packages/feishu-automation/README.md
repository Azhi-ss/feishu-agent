# Feishu Automation (optional)

Standalone scheduled Feishu jobs, extracted from the core without changing the
existing schedule, confirmation, storage or run semantics. This package contains
an independent CLI, Trigger, worker and Pi-compatible Skill. It has no runtime
npm dependencies, no Extension hooks and no imports from Feishu internals.

Requires Node >=22.19 on Linux/WSL or macOS, an initialized `feishu` executable
and `lark-cli` on PATH. Execution always uses `FEISHU_UNATTENDED=1 feishu -p`:
Feishu resource isolation and guards remain active, Mem0 and Remote secrets are
not inherited. The worker uses POSIX exec after admission to preserve the tracked
PID/process group, including crash and cancellation behavior.

## Build and opt in

Not published to npm yet. From the repository root:

```bash
npm run build --workspace @azhi-ss/feishu-automation
feishu install /absolute/path/to/feishu-agent/packages/feishu-automation
```

This installs the package's Skill declaration only; it does not start a service,
create jobs or run a task. The Skill invokes the CLI bundled alongside it, without
requiring a global npm executable link. To run commands yourself:

```bash
node /absolute/path/to/feishu-agent/packages/feishu-automation/dist/cli.js --help
node /absolute/path/to/feishu-agent/packages/feishu-automation/dist/cli.js list
```

For a portable npm artifact (requires the build-time TypeScript compiler):

```bash
npm pack --workspace @azhi-ss/feishu-automation --pack-destination /tmp
```

The tarball contains compiled code, Skill, README and license, not the Feishu
Runtime. npm installation exposes `feishu-automation`; it still requires the
separately installed `feishu`. For a local offline artifact, unpack into a stable
private directory and use `feishu install /absolute/unpacked/package/path`.

## Commands

Where the npm bin is available, use `feishu-automation`; otherwise substitute
`node /absolute/package/path/dist/cli.js` throughout:

```bash
feishu-automation add --name daily --cron '30 8 * * 1-5' --tz Asia/Shanghai \
  --prompt-file task.md --yes          # only after reviewing the complete plan
feishu-automation show daily
feishu-automation list
feishu-automation update daily --timeout 15m --yes
feishu-automation pause daily
feishu-automation resume daily
feishu-automation run daily            # explicit real attempt; may duplicate effects
feishu-automation cancel daily         # no rollback of earlier effects
feishu-automation rm daily             # retain records, disable execution
feishu-automation rm daily --purge --yes # irreversible, separately confirmed
feishu-automation start                # explicit user systemd / launchd activation
feishu-automation status
feishu-automation stop                 # stop before uninstalling/upgrading paths
feishu-automation serve                # foreground alternative
```

Use exactly one schedule: `--cron` numeric five fields, `--every 90m` elapsed
interval, or `--at 2030-06-01T09:00` one-shot. Default timezone Asia/Shanghai;
default catch-up 2h, timeout 10m. Recurring catch-up runs only the latest eligible
occurrence, never a backlog. `--no-catch-up` disables recurring catch-up.
Task text comes from `--prompt-file` or piped `--prompt-stdin`. Creation and
execution-affecting edits require confirmation; non-TTY calls require `--yes`.
`--lark-profile` saves the selected nonsecret profile, not its credentials.

Jobs remain in `~/feishu-jobs`. Same-job attempts never overlap; at most two
jobs run concurrently. Interrupted/failed/unknown attempts are not automatically
replayed. Manual runs do not consume future scheduled occurrences. A completed
runner is not proof of delivery: inspect receipts and logs. Business policy is
prompt-only, not a restricted toolset or security sandbox. Hosts must remain
awake/running; no automatic wake, root, linger, synchronization or failover.

## Migration and removal

- The core no longer accepts `feishu automation ...`; use this package's CLI.
- Existing managed job records require no conversion, but do not start a Trigger
  until their timing and possible catch-up effects have been reviewed.
- Stop the old Trigger using its old binary **before** upgrading/removing it.
  The package retains the service identity and workspace layout; explicit `start`
  refreshes the service to this package's executable after the old owner is stopped.
- Legacy `feishu-briefing.timer` is separate. Disable it before scheduling the same
  deliverable here: `systemctl --user disable --now feishu-briefing.timer`.
  Preserve `~/feishu-automation`, scripts, prompts and run history.
- If an old `~/.feishu-agent/skills/feishu-automation/` exists, archive it outside
  all loaded skill directories before installing this package, retaining edits.
  Core startup/init deliberately does not delete it on another user's behalf.
- Run this package's `stop`, verify `status`, then `feishu remove <same-source>`.
  Removing a package declaration alone cannot stop an OS service. Stopped service
  files and task history remain for audit/recovery; do not delete the workspace.

## Development

`npm test` at the repository root runs the core and package integration tests
against temporary HOMEs, fake service managers and loopback model services.
No real service or Feishu account is used by those tests.
