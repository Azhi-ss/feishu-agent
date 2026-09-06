# Feishu Remote Bridge: one-time setup and usage

The Feishu Remote Bridge is provided by the `@azhi-ss/feishu-remote` workspace
package. It mirrors the active host session (Feishu Agent, or ordinary Pi after
`pi install`) to the owner's 1-on-1 Feishu chat (see ADR
[`0001-remote-bridge-transport.md`](adr/0001-remote-bridge-transport.md)). The
package is transport only: Skills, Mem0, and high-risk approval stay with the
host. `feishu init` installs the package from this repo's workspace path.
Ordinary Pi does not auto-install it.

```bash
feishu init    # installs @azhi-ss/feishu-remote from the CLI install root (absolute path)
pi install /absolute/path/to/feishu-agent/packages/feishu-remote   # optional, ordinary Pi
```

Normal startup never opens a network connection: the bridge is activated
explicitly. Two local sessions cannot share the same bot app: `/remote start`
takes `$HOME/.cache/feishu-remote/<appId>.lock`.

## One-time setup

The bridge reuses the same self-built bot app as `lark-cli` when that config
exists. The app id and owner `open_id` come from the on-disk `lark-cli` config,
or from `FEISHU_REMOTE_APP_ID` and `FEISHU_REMOTE_OWNER_OPEN_ID` if no config
file is present. A broken config does not fall back to env. Only the app secret
needs supplying when `lark-cli` is already logged in:

1. Open the Feishu developer console, find the bot app, and **view** (do not
   reset — resetting invalidates `lark-cli`'s stored secret) its App Secret.
2. Export it for the session only — it is never written to disk:

   ```bash
   export FEISHU_REMOTE_APP_SECRET=<app-secret>
   ```

The secret is held in memory only and is dropped when the bridge stops or the
session shuts down.

## Using the bridge

```bash
feishu                      # start the session, then run `/remote start` in the TUI
FEISHU_REMOTE=1 feishu      # or opt into autostart for a session
```

- `/remote start` / `/remote stop` / `/remote status` manage the connection and
  show `remote:off|connecting|connected|error` in the TUI status line.
- DM the bot from the phone to drive the session; `stop` (or `/stop`, `abort`,
  `/abort`) interrupts the running turn like Ctrl+C.
- A hard connection failure surfaces a TUI warning while the session keeps
  working locally.

## Constraints

- Do **not** run `lark-cli event consume` while the bridge is connected: Feishu
  load-balances events across consumers of the same app.
- Only the owner's 1-on-1 chat can drive the session; group messages and other
  senders are ignored.
- `FEISHU_REMOTE_LOOPBACK_URL` selects the local loopback test adapter; it is
  for tests only and is the sole path exercised by CI.

## Verifying on a real device

1. Export `FEISHU_REMOTE_APP_SECRET`, start `feishu`, run `/remote start`, and
   confirm the TUI shows `remote:connected`.
2. From the phone Feishu app, DM the bot: the message must appear in the TUI
   and drive the session.
3. The reply must stream into a single Card Kit streaming card (typewriter
   effect) with the transient tool-status line during tool calls, clean final
   text, and no raw tool output.
4. Send a message while the agent is busy: it must be acknowledged as queued.
   Send `stop`: the running turn must be interrupted.
5. Run `/remote stop` and confirm the phone channel closes.
