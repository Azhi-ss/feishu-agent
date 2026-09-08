# Feishu Agent

A dedicated assistant for operating Feishu resources. It is separate from general-purpose coding agents even when they use the same underlying agent framework.

## Language

**Feishu Agent**:
The dedicated assistant whose working domain is Feishu and whose capabilities, instructions, packages, and memories are independently controlled. It may inspect or modify project material only when that work directly supports a Feishu deliverable or `lark-cli` workflow, and redirects unrelated software development to a general coding agent. It is a thin executable shell over Pi's public SDK and TUI rather than a fork of Pi source.
_Avoid_: Pi Agent, coding agent, general agent, Pi fork, general software-development assistant

**Feishu Runtime**:
The composition of Pi `AgentSessionRuntime` with Pi's interactive TUI or one-shot print runner, plus Feishu-specific resource loading, package paths, prompts, memory, and tools. Third-party extensions that hard-code `~/.pi/agent` are initialized through a temporary compatibility Home mapped to `~/.feishu-agent/`, while Bash and ordinary subprocesses retain the user's real Home. Local session management and export remain available; persisted sessions resume through `feishu --session <id>`, `feishu -c`, or the `feishu -r` selector rather than ordinary `pi --session-dir ... --session ...`. If the executable is not on PATH, `FEISHU_RESUME_COMMAND` supplies the displayed full path. A Feishu-specific editor rejects `/share`, `/import`, `/login`, and `/logout` before Pi can execute them, although Pi's inherited autocomplete may still display those names. Core tools, the non-replaceable system identity, and the outer command-policy editor are applied after package resources, so installed extensions cannot override those boundaries.
_Avoid_: Forked Pi runtime, modified Pi core, patched third-party package, JSON mode, RPC mode, session sharing, external session import, credential mutation, extension-owned core policy

**Long-term Memory**:
Durable learned context that remains available across Feishu Agent sessions and devices. Automatic learning includes user messages and assistant text replies—but not raw tool results—and is always project-scoped by Git root; `feishu init` records an explicitly chosen stable `feishu:<identity>` Mem0 user ID. Cross-project preferences or raw source material enter memory only through an explicit memory action. Memory is optional at runtime: an unavailable Mem0 service is surfaced clearly but does not block the Feishu Agent's other work.
_Avoid_: Session history, transcript, chat log, shared agent memory, device-local memory, inferred user identity, startup dependency, global automatic capture, raw tool-output capture

**Feishu Agent Home**:
The private configuration root `~/.feishu-agent/` that owns this agent's packages, skills, system prompt, Mem0 state, and centrally stored session files partitioned by Feishu Project. `feishu init` creates this root, installs and configures the default Mem0 package and the Feishu Remote Package, synchronizes official `lark-cli` skills, and validates Lark plus model readiness.
_Avoid_: `~/.pi/agent/`, shared agent home, global agent config, repository-stored transcripts, partially initialized home

**Model Authentication**:
Provider credentials reused read-only from the local Pi installation without sharing Pi's behavior, packages, skills, sessions, memories, or model preference. `feishu init` explicitly selects and stores an independent Feishu default from the authenticated model catalog; credential additions and removals remain ordinary Pi operations.
_Avoid_: Shared Agent Home, duplicated model credentials, inherited Pi default model, Feishu-side login or logout

**Feishu Skill**:
A skill visible only to Feishu Agent. It may come from an installed Feishu Package, the global private directory `~/.feishu-agent/skills/`, the current project's `<project>/.feishu-agent/skills/`, or the read-only official `lark-cli` cache keyed by CLI version. Official skills synchronize lazily when the CLI version changes, retain older successful caches as fallback, and can be refreshed explicitly with `feishu skills sync`; startup never performs network update checks—upgrading `lark-cli` stays a manual `lark-cli update` the user runs themselves. Only the two private skill directories are authoring locations. Duplicate names resolve deterministically in this order: project-private, global-private, installed package, official cache; startup reports every shadowed source.
_Avoid_: Pi skill, Codex skill, `.agents/skills`, shared skill, unversioned CLI skill copy, silent skill shadowing

**Resource Isolation**:
A loading boundary that prevents Feishu Agent from automatically importing other agents' skills, prompts, packages, settings, and context. It is not an operating-system sandbox: Bash retains the current user's filesystem permissions and may inspect project material when needed. A project's `.feishu-agent/` resources and root `AGENTS.md` are considered project context and load automatically without a separate trust decision.
_Avoid_: Filesystem sandbox, container isolation, permission boundary

**Feishu Project**:
The Git repository root that owns project-level Feishu skills, packages, settings, instructions, sessions, and Mem0 scope. When no Git root exists, the startup working directory is the project. Runtime file and Bash paths remain relative to the directory where `feishu` was launched rather than automatically changing to the project root.
_Avoid_: Arbitrary subdirectory as project identity, process-wide workspace, monorepo package root, forced root working directory

**System Prompt Layer**:
The global `~/.feishu-agent/SYSTEM.md` defines the non-replaceable Feishu Agent identity. The current project's `.feishu-agent/AGENTS.md` and root `AGENTS.md` append project-specific instructions without replacing that identity.
_Avoid_: `APPEND_SYSTEM.md`, project system-prompt override, other-agent global context

**Lark Identity**:
The existing `lark-cli` configuration, selected profile, and authenticated user or bot state reused by Feishu Agent without copying tokens into its Agent Home. Personal-resource operations prefer explicit user identity; bot identity is used only when requested or required.
_Avoid_: Feishu Agent token copy, separate Lark login, implicit identity switching

**High-risk Approval**:
Turn-scoped permission for a destructive `lark-cli` write (delete/remove/revoke/withdraw). When the user's current-turn message explicitly asks for a destructive action, the agent may include `--yes`; otherwise the guard blocks it with guidance, and without `--yes` the CLI's own confirmation gate pauses execution (Print mode fast-fails).
_Avoid_: Mandatory duplicate confirmation, blanket approval, inferred destructive intent, metadata-probing per-target approval

**Feishu Package**:
An installable Pi-compatible capability enabled for Feishu Agent rather than for other agents on the machine, except the Feishu Remote Package, which ordinary Pi may also install explicitly. `feishu install` installs globally under `~/.feishu-agent/` by default; `feishu install -l` installs under the current project's `.feishu-agent/`. A private compatibility workspace lets Pi's package manager retain its `.pi` assumptions without creating or loading the project's real `.pi/` directory. Installing a package authorizes all resource types declared by its manifest, including extensions, skills, prompts, and themes, subject to later filtering through `feishu config`; it does not authorize replacement of reserved core tools, the base identity, or command restrictions.
_Avoid_: Global plugin, shared extension, ordinary Pi installation, project `.pi` package storage, core-policy override

**Feishu Remote Package**:
The independently published Pi-compatible npm package `@azhi-ss/feishu-remote` that provides only Remote Bridge transport: `/remote`, the outbound WebSocket, streaming cards, and owner-only session injection. Its source lives in this repository's workspace; Feishu Agent installs a pinned npm version during `feishu init`, while ordinary Pi may install the same package explicitly. Neither host receives Feishu Skills, Mem0, or high-risk approval from this package. It is not a submodule or a separate repository.
_Avoid_: Built-in hidden remote factory, Feishu-Agent-only plugin, skill bundle, core-policy package, git submodule

**Feishu Remote Bridge**:
An optional, session-bound capability, provided by the Feishu Remote Package, that mirrors the active host session (Feishu Runtime or ordinary Pi) to the owner's 1-on-1 Feishu chat over an outbound WebSocket connection without public network exposure. It injects user messages directly into the active session and streams assistant output (via the Feishu Card Kit streaming card, with a transient one-line tool-status strip that is stripped from the final reply) rather than spawning an independent background agent or headless daemon. On Feishu Agent the host still supplies single-session consistency, Mem0, and turn-scoped high-risk guards; those host features are not part of the package. It is strictly owner-only in 1-on-1 private chat (P2P), ignoring group messages and other senders. Activation is explicit via a session command or opt-in configuration, preserving the offline startup invariant. A host-neutral per-app lock prevents two local sessions from sharing the same bot WebSocket.
_Avoid_: Standalone daemon, multi-session server, independent chat bot, public webhook listener, background agent spawn, split-brain session, group-chat execution, multi-user pairing

**Remote Bridge Credential**:
The bot credential the in-process bridge uses: it reuses the existing `lark-cli` bot app rather than a separate identity, so no second app or pairing flow is needed. The app id and the owner's `open_id` are read first from the on-disk `lark-cli` config (zero network). If no config file exists, they may be supplied as `FEISHU_REMOTE_APP_ID` and `FEISHU_REMOTE_OWNER_OPEN_ID`; a present but invalid config does not fall back. The app secret is held in the OS keychain by `lark-cli` and cannot be read in-process, so the owner supplies it once via an environment variable (like Mem0), never persisted into the Feishu Agent Home or ordinary Pi settings. The in-process WebSocket is a separate instance for that app, so a `lark-cli event consume` consumer must not run concurrently or Feishu will load-balance events between them.
_Avoid_: A second dedicated bridge app, storing the app secret on disk, first-DM pairing, concurrent event-consumer sharing

## Unattended Automation

**Automation Workspace**:
The dedicated, non-git working directory from which all unattended runs start; it owns their memory bucket, session partition, and the injected workspace instructions that encode automation policy. It is deliberately outside the Feishu Agent Home, which remains disposable runtime state.
_Avoid_: Reusing an interactive project directory, a path inside the Agent Home, relocating the workspace after first use

**Trigger**:
The only always-on part of unattended automation: an external scheduler or watcher that starts fresh one-shot runs. A Trigger never holds model context itself.
_Avoid_: A long-lived agent process, a continuously running "brain", sleeping agent loop

**Briefing**:
A scheduled summary run that pulls the day's hard items (calendar, open tasks, pending approvals), recent work traces (recently edited docs), and at-mentions fresh at delivery time; persistent memory may personalize ordering but is never a source of facts.
_Avoid_: Memory-generated digest, full-text document scan, transcript archive

**Sweep**:
A scheduled, identity-based patrol that searches the owner's recent at-mentions and work-item changes without adding the bot to any chat. A cheap command-level prefetch decides whether a model run is needed at all; when nothing changed, no model turn runs.
_Avoid_: Bot-in-group monitoring, full chat-history ingestion, unconditional model invocation

**Alert**:
An escalation of a Sweep result judged P0, delivered through Feishu urgent channels (in-app, then SMS/phone), subject to an explicit policy: severity threshold, quiet hours, and per-day cap. Alerts are the last layer built, never the default output of a Sweep.
_Avoid_: Routine phone buzz, model-self-authorized urgent calls, unbounded escalation frequency


