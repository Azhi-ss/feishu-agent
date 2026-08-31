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

Initialization creates private state under `~/.feishu-agent/`, selects an independently stored Feishu model, installs the unmodified Mem0 package, synchronizes official `lark-cli` Skills, and runs `lark-cli doctor`. Re-running fills missing state and does not overwrite identity, model, or customized `SYSTEM.md`.

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
feishu update
feishu skills sync
```

Global packages live below `~/.feishu-agent/`; project packages live in `<git-root>/.feishu-agent/`. Official and private Feishu Skills never scan ordinary Pi, `.pi`, `.agents`, Codex, or Claude skill roots.

## Lark Identity and High-risk Approval

Feishu Agent reuses existing `lark-cli` state without copying tokens. Personal-resource operations use explicit `--as user`; Bot identity is only used when requested or required. An exact destructive action can receive one operation-scoped High-risk Approval; ambiguous, widened, or repeated destructive work requires new approval.

## Long-term Memory

Mem0 automatically captures user messages and Assistant text under Project Scope. Raw tool output is not auto-captured; Global memory requires an explicit action. `MEM0_API_KEY` remains environment-only and telemetry is disabled. Memory failure is non-blocking and should produce a degraded warning.

## Isolation and limitations

Resource Isolation prevents automatic loading from other agents; it does not restrict filesystem, subprocess, extension, or network permissions. Installed Feishu Package extensions execute with current-user permissions. Feishu Agent does not copy Lark/model tokens, support session sharing/import, or accept unrelated general software-development work; use ordinary `pi` for that.
