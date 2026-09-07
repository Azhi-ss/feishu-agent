# @azhi-ss/feishu-remote

A transport-only [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
extension that lets the owner drive the active Pi session from a one-to-one
Feishu/Lark bot chat. Replies stream back through a Card Kit card.

It provides `/remote`, the outbound WebSocket transport, owner-only inbound
message filtering, turn queuing, and streaming-card delivery. It does not
include Feishu Agent Skills, Mem0, or high-risk action policy.

## Requirements

- Node.js 22.19 or later
- A self-built Feishu/Lark bot app with WebSocket event delivery enabled
- The bot's App Secret in `FEISHU_REMOTE_APP_SECRET`
- The App ID and owner `open_id`, resolved in one of these ways:
  - an existing `lark-cli` config under `~/.lark-cli/config.json` or the XDG
    config path; or
  - `FEISHU_REMOTE_APP_ID` and `FEISHU_REMOTE_OWNER_OPEN_ID` when no
    `lark-cli` config exists

A present but invalid `lark-cli` config is treated as an error and does not
fall back to environment identity.

## Install

```bash
pi install npm:@azhi-ss/feishu-remote
```

Export the secret for the Pi process. It is kept in memory and is never written
to Pi settings or session files.

```bash
export FEISHU_REMOTE_APP_SECRET=<app-secret>
pi
```

Then run:

```text
/remote start
/remote switch
/remote status
/remote stop
```

Set `FEISHU_REMOTE=1` to opt into autostart for each interactive session.
Normal Pi startup stays offline when this variable is unset.

## Constraints

- Only the configured owner's one-to-one chat can drive the session. Group
  messages and other senders are ignored.
- Do not run `lark-cli event consume` for the same app while the extension is
  connected. Feishu load-balances events across concurrent consumers.
- Two local sessions cannot share one bot app. The active window holds a
  per-App-ID lock (JSON metadata: pid, start time, cwd) under
  `$HOME/.cache/feishu-remote/`.
- Switching which window answers the phone: in the new window run
  `/remote switch`. It asks the holding window (via a short-lived yield file,
  not signals) to stop, waits for the lock, then connects. A window that starts
  while another holds the lock can either fail (`/remote start`) or, with
  `FEISHU_REMOTE=1`, sit in `standby` and show the holder in its status line.
- Session replacement (`/new`, resume, fork, or reload) closes the old bridge.
  Start it again in the replacement session, or use `FEISHU_REMOTE=1`.

## License

MIT
