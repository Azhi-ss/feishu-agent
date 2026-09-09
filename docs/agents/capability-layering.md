# Capability Layering — Prompt, Skill, Tool, Extension, Package

When adding a capability to Feishu Agent, implement it at the **lowest layer
that can form a deterministic closed loop**. Move up only when a lower layer
cannot provide execution, a lifecycle hook, or a distribution boundary.

Source: distilled from Wu Zikang's Pi v0.82.1 layering article (2026-08); the
mechanism taxonomy and permission boundaries are stable, but concrete field
names and event sets are version-sensitive — refresh them against the pinned
Pi SDK in `package.json` (currently 0.84.x; see the AGENTS.md 0.85.x
regression note) before writing code against an API shown in any external
article.

## The five things a "plugin request" may actually be

These are not a power ranking; one request often mixes several of them.

| Layer | What it changes | Triggered by | Determinism | Main risk |
|---|---|---|---|---|
| **Prompt Template** | The task text the user submits (`/name` expands a Markdown fragment, with args/defaults) | User, explicitly | Low — the model may interpret | Prompt injection, skipped steps |
| **Skill** | On-demand knowledge, steps, and bundled files (`SKILL.md` + scripts/references/assets; index in system prompt, body read when matched) | Model or user | Medium — *discovered ≠ executed* | Malicious instructions, script supply chain |
| **Tool** | A structured action: name, JSON schema, executor, structured result (in Pi, tools are registered by an Extension via `registerTool()`) | Model | High — validated args, observable lifecycle | Execution permission, side effects |
| **Extension** | Runtime events, policy, context, UI (`before_agent_start`, context/tool-call hooks, session events, status line; may register tools/commands/flags/providers) | Runtime | High — **enforceable** | Arbitrary in-process code, context tampering |
| **Package** | Install, pin, filter, and distribute any of the above (npm/git/local path, `pi` field or convention dirs) | Admin/project setup | Distribution determinism only | Dependencies, provenance, updates |

A Package never downgrades an Extension's privileges and never makes a Skill
execute deterministically. Filtering resources shrinks the load surface; it is
not a sandbox. Pinning a version proves content identity, not trust.

## Decision ladder — start at the bottom

1. Only reusing task wording? → **Prompt Template**
2. On-demand knowledge / multi-step workflow / companion files? → **Skill**
3. Structured parameters, cancellation, or a structured result for an action? → **Tool**
4. Must enforce policy outside the model, or react to a Runtime lifecycle event? → **Extension**
5. Needs install, version pinning, or cross-machine/team sharing? → wrap it in a **Package** (a delivery dimension, not mutually exclusive with 1–4)

Ask first: **who triggers it? what authority does it need? which lifecycle
must it act in? should the text be always in context? does it need to install
and update across projects?**

## Rules that follow

- Polishing a prompt never buys a Runtime guarantee. "Never write to prod" /
  "never run destructive X" expressed only in Markdown relies on the model
  remembering; enforcement belongs in a tool gate / Extension hook / OS
  permission.
- Skill acceptance has four layers: discovery → body read → script invocation
  → result verification. A skill appearing in the capability list proves only
  layer 1.
- "An Extension is more reliable" is true for determinism, false for safety:
  it runs with full current-user permissions and can alter what the model
  sees. It needs source review, event-ordering regression tests, and
  dependency governance.
- Prefer the OS/native mechanism over a hook when it closes the loop (file
  permissions, an external scheduler, a read-only mount).
- Keep the simpler alternative explicitly available; the least-privilege
  implementation is usually also the easiest to roll back, audit, and move.

## Test contracts per layer

- **Template**: argument-expansion snapshots.
- **Skill**: discovery, body-loading, and script-boundary tests (never assert
  the model "will" read it).
- **Tool**: schema validation, cancellation, idempotency, and side-effect
  tests against loopback/fake services.
- **Extension**: event ordering, interception, and context-diff tests.
- **Package**: provenance, pinned version, resource filtering, dependency
  manifest — and review each bundled resource type separately; "installed
  from one package" is not one trust decision.

## How this maps onto feishu-agent today

- **Extension layer**: the turn-scoped high-risk guard (`src/high-risk.ts`)
  blocks destructive `lark-cli` commands with `--yes` — enforceable because it
  runs before tool execution; a prompt could not do this.
- **Prompt policy layer**: the Automation Workspace `AGENTS.md` standing policy
  (SPEC §16). It is deliberately prompt-level only; ADR-0003 names the exact
  triggers that require upgrading it to a hard command policy (Sweep write
  actions, Alert, bot-in-group, any observed out-of-policy call).
- **Skill layer**: official `lark-*` Skills, `/find-skill`, and the host
  `skills/feishu-control/` distribution resource. Skill-bundled scripts are
  real supply-chain surface even though they are "just Markdown + scripts".
- **Package layer**: pinned `@mem0/pi-agent-plugin`, the allow-listed
  `@azhi-ss/feishu-remote`, and resource filtering in `src/resources.ts`.
  Pinning and allow-listing are provenance controls, not sandboxes — the
  AGENTS.md isolation boundary says so in user-facing terms.
- **OS/native before hook**: unattended scheduling uses external systemd
  user timers spawning ephemeral print runs (ADR-0002, SPEC §16.5), not a
  resident Extension loop; the feishu side adds only a Tool-grade management
  surface (`feishu automation`). Startup stays zero-network/zero-blocking by
  construction — a built-in scheduler daemon would violate that boundary.

## Anti-examples

- Putting a "reject dangerous parameters" check inside a Skill or AGENTS.md
  and treating it as enforced.
- Compressing domain knowledge into a tool description to save a Skill —
  recreates permanent context bloat with none of the auditability.
- Shipping one Package containing a template, a skill, a tool, and an
  Extension and signing off on all four after reviewing only the Extension.
- Writing a custom Runtime hook when an OS permission or external scheduler
  already closes the loop.
