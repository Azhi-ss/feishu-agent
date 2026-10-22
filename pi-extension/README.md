# Host pi Extension: `feishu` delegation tool

A single-file pi Extension that gives a host pi Agent one structured `feishu` tool for delegating
Feishu/Lark work to the Feishu Agent. It is a **thin shell over `../skills/feishu/feishu-send`**: the
delegation protocol (summary vs raw mode, exit codes, session/profile/cwd continuation) lives in that
script and in `../skills/feishu/SKILL.md`, and only there. When this Extension breaks, the Skill bridge
still works.

## What it adds

1. `feishu` tool (`registerTool`) — parameters `task`, `session`, `mode` (`summary`/`raw`), `profile`.
   It spawns `feishu-send` and maps the exit code: `0` reply, `3` waiting for the user, `124` timeout,
   anything else a redacted failure. Every result carries the session ID, project directory and profile.
2. Session ledger (`appendEntry`) — one durable entry per run, and a reminder in the next result when
   the previous delegation in this directory is still continuable, so the host does not have to remember
   the ID from stderr.
3. `lark-cli` backstop (`tool_call` hook) — blocks host Bash commands that invoke `lark-cli` directly
   and points them at the `feishu` tool.

It deliberately adds nothing else: no delegation protocol logic, no retries, no scheduling, no state
files of its own.

## Dependencies and type checking

The file imports only `node:` builtins, `@earendil-works/pi-coding-agent` and `typebox`. Both Pi
packages come from the host pi runtime, which exposes them to extensions as virtual modules, so this
repository declares no dependency on them. A bare `tsc` therefore cannot resolve `typebox` (it exists
only nested inside the pinned SDK): to type-check the file from a checkout, run tsc from the repository
root with a temporary `tsconfig.pi-extension.check.json` that maps `typebox` to
`./node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.d.mts` and lists only
`pi-extension/feishu-delegate.ts`. The file stays out of the repository's own build (`tsconfig.json`).

## Install (host machine)

Symlink the file, do not copy it: the Extension resolves `feishu-send` relative to its own real path.

```bash
ln -sfn "$HOME/tools/feishu-agent/pi-extension/feishu-delegate.ts" "$HOME/.pi/agent/extensions/feishu-delegate.ts"
```

Install the Skill bridge next to it (see the repository README) — the Extension calls that script.
Then restart pi. The extension needs no build step; pi loads TypeScript directly.

## Install boundary

This is a **host-side distribution resource**, not a Feishu Agent resource. Never install it into
`~/.feishu-agent/` and never ship it as part of a Feishu Package: that would make the Feishu Agent
install a tool that calls itself. The Feishu Runtime does not load this file.

## Smoke check after installing

The Extension is not covered by the repository test suite (the host pi version and the SDK version
pinned in this repository can differ), so verify it on the host once. After a pi upgrade, rerun step 0
first: it loads the Extension with the installed pi's own extension loader, makes no model calls, and
catches the whole class of API drift (missing tool / renamed hook / dropped `typebox` alias).

0. Free load check, from the repository root (`node` prints the registered tool and handler):

```bash
cat > /tmp/feishu-load-check.mjs <<'JS'
import { discoverAndLoadExtensions } from "/ABSOLUTE/PATH/TO/pi/dist/index.js";
const result = await discoverAndLoadExtensions([], process.cwd(), process.env.HOME + "/.pi/agent");
const ext = result.extensions.find((e) => e.path.includes("feishu-delegate"));
console.log("errors:", result.errors, "\ntools:", [...(ext?.tools.keys() ?? [])], "handlers:", [...(ext?.handlers.keys() ?? [])]);
JS
node /tmp/feishu-load-check.mjs
```

Resolve `/ABSOLUTE/PATH/TO/pi/dist/index.js` from the running install, for example
`node -e 'console.log(require.resolve("@earendil-works/pi-coding-agent/dist/index.js"))'` run with
that install's node, or `readlink -f "$(command -v pi)"` and walk up to its package root. Expected
output: `errors: []`, `tools: [ 'feishu' ]`, `handlers: [ 'tool_call' ]`.

1. Start pi and confirm the `feishu` tool is listed, with the four parameters above.
2. Ask pi to run `lark-cli profile list` in Bash: the call must be blocked with the "direct lark-cli
   calls are blocked" reason instead of executing.
3. Run one harmless real delegation (for example a task that only reads a Feishu resource) and confirm
   the result text ends with a `Feishu session: <id> (project …, profile …)` line, and that pi reports
   the run in the transcript with its status and duration.
4. Fallback: hide the symlink, restart pi, and delegate through the Skill bridge
   (`feishu-send "<task>"`) — that path must still work.

## Known failure mode

A pi upgrade can change the Extension API. The failure is visible and cheap: the tool disappears and pi
prints one error line, and the step 0 load check above fails with an `errors` entry instead of
`errors: []`. Recovery is either adapting the three API calls above or simply removing the symlink and
using the Skill bridge, which needs no Extension.
