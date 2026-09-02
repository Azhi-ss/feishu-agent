# Feishu Agent

Feishu Agent is a thin executable shell over Pi's public SDK and TUI for Feishu deliverables and `lark-cli` workflows. It is not a Pi fork or a general coding agent. Resource Isolation is not an OS sandbox.

## Build

```bash
npm install
npm run build
node dist/src/cli.js --help
```

The npm binary is `feishu` after package linking/installation.

## Initialize

```bash
MEM0_API_KEY=... feishu init --identity stable-name --model provider/model --thinking medium
```

Initialization creates private state under `~/.feishu-agent/`, requires an explicit authenticated Feishu model on fresh initialization, stores a supported Feishu-only thinking preference, validates Mem0 connectivity without printing the key, installs the unmodified Mem0 package, synchronizes official `lark-cli` Skills, and runs `lark-cli doctor` under the invocation's selected profile. Re-running fills missing state and does not overwrite identity, model, or customized `SYSTEM.md`. Use `--reset-identity`, `--reset-model`, or `--reset-system` for explicit replacement.

## Run

```bash
feishu                    # Interactive Feishu Runtime
feishu -p "task"          # one Print-mode turn
feishu -c                 # continue this Feishu Project's latest session
feishu -r                 # select a session in this Feishu Project
feishu --session <id>     # resume an exact session in this Feishu Project
feishu --lark-profile finance -p "task"
```

Normal Interactive exit rewrites Pi's generic resume line to `To resume this Feishu session: feishu --session <id>`; copy that command to resume the exact session. Use `feishu -c` for the latest session or `feishu -r` to choose one. If `feishu` is not on PATH, set `FEISHU_RESUME_COMMAND` to the full executable path. Do not resume Feishu sessions through ordinary `pi --session-dir ... --session ...`, because that bypasses the Feishu Runtime boundary.

The Feishu Runtime disables Pi's built-in startup network checks, so you will never see Pi's `pi update` version notice or `pi update --extensions` package-update notice: upgrading Pi or extensions stays a deliberate, out-of-band action.

Only Interactive and text Print modes are supported. JSON and RPC are intentionally absent.

## Packages and Skills

```bash
feishu install npm:package
feishu install -l ./local-package
feishu list
feishu remove package
feishu update --extensions
feishu config set npm:package extensions off
feishu config -l set ./local-package skills off
feishu skills sync
```

Global packages live below `~/.feishu-agent/`; project packages live in `<git-root>/.feishu-agent/`. Manifest Extensions, Skills, Prompts, and Themes load with Pi package filtering semantics; omitted types load all, `[]` loads none, glob exclusions narrow, and exact `+path`/`-path` entries force inclusion/exclusion. `feishu config` starts in Feishu global settings and `feishu config -l` starts in project Feishu settings; `feishu config [ -l ] set <source> <resource> <on|off>` is the scriptable equivalent for durable resource toggles. The isolated UI child prevents Pi's config exit behavior from terminating an embedding host. Official and private Feishu Skills never scan ordinary Pi, `.pi`, `.agents`, Codex, or Claude skill roots.

## Lark Identity and High-risk Approval

Feishu Agent reuses existing `lark-cli` state without copying tokens. Personal-resource operations use explicit `--as user`; Bot identity is only used when requested or required. A natural request that unambiguously states the destructive action, exact target, user/bot identity, and impact scope grants one matching `lark-cli ... --yes` operation. Ambiguous, chained, widened, changed, or repeated destructive work is blocked; Print mode terminates instead of prompting. This runtime guard is not an OS security boundary.

## Long-term Memory

The direct `mem0ai` dependency is pinned to 3.0.8, the first compatible 3.x release using `uuid` 11.1.1; `npm audit --omit=dev` is clean for the installed production tree. Mem0 automatically captures user messages and Assistant text under the collision-proof Feishu Project key. Raw tool output is not auto-captured; Global memory requires an explicit action. The configured `feishu:<identity>` overrides external `MEM0_USER_ID`, `MEM0_API_KEY` remains environment-only, and telemetry is disabled. Startup performs a bounded health check; recall, capture, or Dream failure emits both terminal and Interactive warnings and disables later memory actions for that degraded session. A later healthy invocation recovers without changing unrelated Feishu settings.

## Offline release matrix

The release suite compiles the real CLI and exercises it only with temporary homes/projects, PTYs, and loopback fake model, Mem0, Lark, and npm services—never real network endpoints or user credentials. It verifies:

- a fresh HOME can run `feishu init`, an immediate Print turn, a mounted Interactive turn, a fake personal Lark command with explicit `--as user`, project-local sessions, and eligible user/Assistant memory capture;
- hostile ordinary Pi home/project `.pi` and `.agents` resources stay unloaded, conflicting package core tools are rejected with warnings, and a replacement prompt or custom editor cannot replace the base identity or outer command guard;
- two projects share only the configured global `feishu:<identity>` while keeping sessions, private Skills, package settings, loaded package Skills, and collision-proof Mem0 app IDs independent;
- degraded Mem0 and official Skill fallback emit visible warnings while core file, Bash, Lark, Print, and Interactive work continues;
- recursive artifact and diagnostic scans reject Mem0 secrets and copied Lark tokens, while raw tool output remains local to sessions and is excluded from automatic Mem0 capture.

## Isolation and limitations

Resource Isolation prevents automatic loading from other agents; it does not restrict filesystem, subprocess, extension, or network permissions. Installed Feishu Package extensions execute with current-user permissions. Feishu Agent does not copy Lark/model tokens, support session sharing/import, or accept unrelated general software-development work; use ordinary `pi` for that.
