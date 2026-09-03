# Feishu Agent

A thin CLI agent and TUI shell over Pi's SDK and `lark-cli` for Feishu (飞书) / Lark automation, skills, and workflows — long-term memory, skill authoring, and high-risk approval guards for Feishu deliverables.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/Azhi-ss/feishu-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Azhi-ss/feishu-agent/actions/workflows/ci.yml)
[![Node ≥ 22.19](https://img.shields.io/badge/node-%E2%89%A5%2022.19-339933?logo=node.js&logoColor=white)](https://nodejs.org)

**English** | [简体中文](README.zh-CN.md)

Feishu Agent is a thin executable shell over Pi's public SDK and TUI for Feishu deliverables and `lark-cli` workflows. It is not a Pi fork or a general coding agent. Resource Isolation is not an OS sandbox.

## What you can do

Feishu Agent drives Feishu/Lark work through natural language, backed by the 28 official `lark-cli` skills (messaging, docs, calendar, Base, approvals, and more). Use it to:

- **Send and manage messages** — post to chats, reply in threads, upload files, and handle interactive cards as a Feishu bot (`lark-im`); build a Feishu/Lark chat bot without writing integration code.
- **Automate documents and files** — create and edit Feishu Docs (Docx), Sheets, Slides, and cloud-drive files (`lark-doc`, `lark-sheets`, `lark-slides`, `lark-drive`).
- **Run workflow automations** — summarize meetings and minutes, draft standup reports, and script multi-step Feishu workflows (`lark-workflow-*`, `lark-meeting`, `lark-minutes`).
- **Manage calendar and approvals** — check schedules, book meeting rooms, and process approval tasks (`lark-calendar`, `lark-approval`).
- **Operate Bitable / Base** — create tables, fields, records, views, and dashboards in Feishu Base (`lark-base`).
- **Remember across sessions** — project-scoped long-term memory via Mem0; secrets and raw tool output stay out of capture.
- **Author your own skills** — encode repeatable Feishu workflows as private skills (`feishu-skill-maker`).
- **Extend with packages** — add MCP servers, web access, and subagents through Pi-compatible extensions.

High-risk actions (deletes, revocations, `/share`) require explicit one-shot approval; ambiguous or chained destructive commands are blocked.

## Install

Feishu Agent runs as a CLI from source — it is **not published to npm**.

### Prerequisites

- **Node.js ≥ 22.19**
- **[`lark-cli`](https://github.com/larksuite/cli)** — the official Feishu/Lark CLI, npm package **`@larksuite/cli`**. Install with `npm i -g @larksuite/cli`, then run `lark-cli auth` to log in so `lark-cli doctor` passes.
  > Install `@larksuite/cli`, **not** the unrelated placeholder package literally named `lark-cli` on npm.
- **[Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)** coding agent — `npm i -g @earendil-works/pi-coding-agent`. Feishu reuses Pi's model credentials from `~/.pi/agent/` and disables its own `/login`, so authenticate a model with ordinary `pi` first (`pi auth` checks readiness).
- **`MEM0_API_KEY`** from [mem0.ai](https://mem0.ai) — required by `feishu init` for long-term memory. Read only from the environment, never written to disk; memory degrades gracefully at runtime if Mem0 is later unavailable.

### Build and link

```bash
git clone https://github.com/Azhi-ss/feishu-agent.git
cd feishu-agent
npm install
npm run build
npm link          # exposes the `feishu` binary (or run `node dist/src/cli.js` directly)
```

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

### Defaults (what you get out of the box)

`feishu init` sets up a minimal runtime. Nothing is preloaded beyond:

| Capability | Source | Notes |
|---|---|---|
| Long-term memory | `@mem0/pi-agent-plugin` (pinned, auto-installed by `feishu init`) | Project-scoped semantic capture of user/assistant text; `MEM0_API_KEY` env-only |
| Core policy guard | built-in (hidden `feishu-core-policy` extension) | High-risk `lark-cli --yes` approval gate, blocked `/share` `/import` `/login` `/logout` |
| Skill authoring | built-in `feishu-skill-maker` skill | Guide for creating new Feishu Skills |
| Official Feishu skills | read-only cache from the local `lark-cli` (28 skills: lark-im, lark-doc, lark-calendar, …) | Keyed by CLI version, synced lazily; refresh with `feishu skills sync` |
| Core tools | `read` `edit` `write` `bash` `grep` `find` `ls` | Third-party packages cannot replace these names |

Themes and prompt templates are not bundled; load them via packages as needed.

### Recommended optional packages

Pi-compatible extension packages install with `feishu install npm:<package>`. Feishu does **not** auto-install any of these — opt in per machine/project. All listings below are real, `pi-coding-agent`-compatible npm packages; verify the current version with `npm view <package>` before pinning.

| Package | What it adds | When to install |
|---|---|---|
| `pi-web-access` | Web search, URL fetching, GitHub repo cloning, PDF extraction, YouTube/video understanding; pluggable backends (Tavily, Firecrawl, Jina, Exa, Gemini, Kimi, SearXNG, …) | **Most recommended** — when Feishu needs to read online docs, look up Feishu API references, or fetch a link |
| `pi-mcp-adapter` | Use MCP (Model Context Protocol) servers as tools | You already have MCP servers (or want a specific vendor's MCP integration) |
| `pi-subagents` | Single-agent delegation and scripted multi-agent workflows | Long, parallelizable Feishu tasks |
| `pi-background-tasks` | Durable background shell tasks, read-only delegated agents, attested local Pi runs | Letting long-running lark-cli jobs survive the session |
| `pi-hermes-memory` | Persistent memory + session search + secret scanning, token-aware policy-only capture | Alternative/additional memory engine; note Feishu already ships Mem0 |

```bash
feishu install npm:pi-web-access        # recommended, global
feishu install -l npm:pi-mcp-adapter     # current project only
feishu list
feishu remove npm:pi-subagents
feishu update --extensions
feishu config set npm:pi-web-access extensions off
feishu config -l set ./local-package skills off
feishu skills sync
```

Not recommended for Feishu: packages from the `@oh-my-pi/*` ecosystem — those target the separate `oh-my-pi`/`omp` agent, not `pi-coding-agent`, and are not compatible with this runtime.

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
