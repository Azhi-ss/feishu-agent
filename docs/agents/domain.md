# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This is a **single-context** repo: one `CONTEXT.md` at the root plus `docs/adr/` for decisions.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the domain language glossary for Feishu Agent (Feishu Runtime, Agent Home, Lark Identity, High-risk Approval, Feishu Skill, Resource Isolation, etc.). Read it before naming or arguing about any concept.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

Note: `SPEC.md` is this repo's primary engineering/design spec (user stories, implementation decisions, CLI surface, test matrix) and is the source of truth when it disagrees with README prose. `AGENTS.md` is the project action guide for coding agents.

## File structure

Single-context repo:

```
/
├── CONTEXT.md
├── SPEC.md
├── docs/
│   ├── adr/
│   └── agents/
│       ├── issue-tracker.md
│       ├── triage-labels.md
│       └── domain.md
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR (or a recorded decision in `SPEC.md`), surface it explicitly rather than silently overriding:

> _Contradicts SPEC.md §… — but worth reopening because…_
