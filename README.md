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
MEM0_API_KEY=... feishu init --identity stable-name --model provider/model
```

Initialization creates private state under `~/.feishu-agent/`, requires an explicit Feishu model when more than one authenticated model is available, validates Mem0 connectivity without printing the key, installs the unmodified Mem0 package, synchronizes official `lark-cli` Skills, and runs `lark-cli doctor`. Re-running fills missing state and does not overwrite identity, model, or customized `SYSTEM.md`. Use `--reset-identity`, `--reset-model`, or `--reset-system` for explicit replacement.

## Run

```bash
feishu                    # Interactive Feishu Runtime
feishu -p "task"          # one Print-mode turn
feishu -c                 # continue this Feishu Project
feishu -r                 # current-project session selection
feishu --lark-profile finance -p "task"
```

Only Interactive and text Print modes are supported. JSON and RPC are intentionally absent.

## Packages and Skills

```bash
feishu install npm:package
feishu install -l ./local-package
feishu list
feishu remove package
feishu update --extensions
feishu config
feishu skills sync
```

Global packages live below `~/.feishu-agent/`; project packages live in `<git-root>/.feishu-agent/`. Manifest Extensions, Skills, Prompts, and Themes load with Pi package filtering semantics; `feishu config` edits only Feishu settings through an isolated compatibility CWD. Official and private Feishu Skills never scan ordinary Pi, `.pi`, `.agents`, Codex, or Claude skill roots.

## Lark Identity and High-risk Approval

Feishu Agent reuses existing `lark-cli` state without copying tokens. Personal-resource operations use explicit `--as user`; Bot identity is only used when requested or required. A `lark-cli ... --yes` command is allowed only when the current request explicitly names that exact command, and that approval is consumed once. Ambiguous, widened, or repeated destructive work is blocked; Print mode terminates instead of prompting. This runtime guard is not an OS security boundary.

## Long-term Memory

Mem0 automatically captures user messages and Assistant text under the collision-proof Feishu Project key. Raw tool output is not auto-captured; Global memory requires an explicit action. The configured `feishu:<identity>` overrides external `MEM0_USER_ID`, `MEM0_API_KEY` remains environment-only, and telemetry is disabled. Startup performs a bounded health check; failure emits a secret-redacted warning and leaves memory recall, capture, and Dream disabled for that session.

## Isolation and limitations

Resource Isolation prevents automatic loading from other agents; it does not restrict filesystem, subprocess, extension, or network permissions. Installed Feishu Package extensions execute with current-user permissions. Feishu Agent does not copy Lark/model tokens, support session sharing/import, or accept unrelated general software-development work; use ordinary `pi` for that.
