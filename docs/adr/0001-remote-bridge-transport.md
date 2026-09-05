# Remote Bridge uses the official Feishu SDK in-process (not a `lark-cli` subprocess)

The Feishu Remote Bridge (mobile → active TUI session mirroring over an outbound
WebSocket) needs a transport to receive Feishu events and reply. We decided to use
the official `@larksuiteoapi/node-sdk` `WSClient` running **inside the extension
process**, rather than shelling out to `lark-cli event consume` subprocesses.

This deliberately adjusts two of the repo's standing boundaries, with the owner's
explicit approval:

1. **A new pinned dependency is allowed** — `@larksuiteoapi/node-sdk` is added to
   `package.json` at a pinned version. (AGENTS.md normally forbids new deps.)
2. **Credentials are supplied via environment variable, reusing the existing
   `lark-cli` bot app** — the bridge uses the same self-built Feishu app that
   `lark-cli` uses (`cli_aa8c6ae6c6bbdbdd`, "曾宇的飞书 CLI"), which already has
   bot capability, WebSocket event delivery, and all IM + Card Kit scopes. Its
   `appId` and the owner's `open_id` are read from the on-disk `lark-cli` config;
   the `appSecret` is supplied through an environment variable (the same pattern
   as `MEM0_API_KEY`), never copied, logged, or persisted into
   `~/.feishu-agent/`.

Why the secret needs an env var rather than being read from `lark-cli`: on Linux
the `lark-cli` app secret is held in the OS keychain (its config stores only a
`{source:"keychain"}` reference and `config show` masks it as `****`), and this
box has no `secret-tool`/libsecret backend for an in-process SDK to read it. The
owner views the existing secret once in the Feishu developer console (view, not
reset — resetting would invalidate `lark-cli`'s stored secret) and provides it via
env. Reusing the existing app also means the owner `open_id` is known from the
`lark-cli` config, so no first-DM pairing flow is needed.

Caveat: the in-process SDK WebSocket is a separate long-connection instance for
the same app. Feishu load-balances events across concurrent instances, so do not
run `lark-cli event consume` while the bridge is connected; the lark-cli event bus
auto-exits when idle, so the bridge is normally the sole consumer.

## Considered Options

- **`lark-cli event consume` subprocess** (rejected): zero new dependency and zero
  secret handling, matching the normal Feishu path. But it routes the long-lived
  connection through `lark-cli`'s local bus daemon. A consumer that exits
  abnormally (`kill -9`, crash, power loss) can leave a server-side zombie
  connection (`online_instance_cnt=1`) that blocks the next consumer and is not
  reliably cleared by `event status/stop` (larksuite/cli#1381). For an always-on
  remote channel the user depends on while away from the machine, that extra
  process layer and its reconnection/lifecycle uncertainty outweigh the dependency
  cost.

- **Official SDK `WSClient` in-process** (chosen): the WebSocket lives in our own
  extension process, so reconnection, heartbeat, and teardown are controlled
  directly with no middle daemon. This is also the pattern every mature reference
  implementation uses (OpenClaw's built-in Feishu channel,
  claude-code-feishu-channel, pi-feishu-lark).

## Consequences

- `@larksuiteoapi/node-sdk` is pinned in `package.json`; upgrades follow the same
  deliberate-version discipline as the Pi SDK.
- The bridge reads its secret from an environment variable lazily on
  `/remote start` (or opt-in autostart); the secret is kept out of session files,
  logs, error messages, and tests, and dropped on `session_shutdown`.
- The reused bot already holds the required scopes (IM receive/send/update +
  Card Kit); no new app or permission grant is needed.
- Startup stays offline by default: the SDK client is created only on explicit
  activation, never during the normal `feishu` launch path.
