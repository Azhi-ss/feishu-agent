# Overnight implementation log

## Published delivery tickets

- T01: [#1](https://github.com/Azhi-ss/feishu-agent/issues/1) — blocked by none
- T02: [#2](https://github.com/Azhi-ss/feishu-agent/issues/2) — blocked by T01/#1
- T03: [#3](https://github.com/Azhi-ss/feishu-agent/issues/3) — blocked by T01/#1, T02/#2
- T04: [#4](https://github.com/Azhi-ss/feishu-agent/issues/4) — blocked by T01/#1, T03/#3
- T05: [#5](https://github.com/Azhi-ss/feishu-agent/issues/5) — blocked by T04/#4
- T06: [#6](https://github.com/Azhi-ss/feishu-agent/issues/6) — blocked by T01/#1, T02/#2
- T07: [#7](https://github.com/Azhi-ss/feishu-agent/issues/7) — blocked by T04/#4, T06/#6
- T08: [#8](https://github.com/Azhi-ss/feishu-agent/issues/8) — blocked by T03/#3, T07/#7
- T09: [#9](https://github.com/Azhi-ss/feishu-agent/issues/9) — blocked by T01/#1, T03/#3
- T10: [#10](https://github.com/Azhi-ss/feishu-agent/issues/10) — blocked by T08/#8, T09/#9
- T11: [#11](https://github.com/Azhi-ss/feishu-agent/issues/11) — blocked by T10/#10
- T12: [#12](https://github.com/Azhi-ss/feishu-agent/issues/12) — blocked by T04/#4, T10/#10
- T13: [#13](https://github.com/Azhi-ss/feishu-agent/issues/13) — blocked by T08/#8, T12/#12
- T14: [#14](https://github.com/Azhi-ss/feishu-agent/issues/14) — blocked by T06/#6, T08/#8
- T15: [#15](https://github.com/Azhi-ss/feishu-agent/issues/15) — blocked by T03/#3, T07/#7, T14/#14
- T16: [#16](https://github.com/Azhi-ss/feishu-agent/issues/16) — blocked by T15/#15
- T17: [#17](https://github.com/Azhi-ss/feishu-agent/issues/17) — blocked by T01/#1, T02/#2
- T18: [#18](https://github.com/Azhi-ss/feishu-agent/issues/18) — blocked by T03/#3, T17/#17
- T19: [#19](https://github.com/Azhi-ss/feishu-agent/issues/19) — blocked by T05/#5, T06/#6, T15/#15, T18/#18
- T20: [#20](https://github.com/Azhi-ss/feishu-agent/issues/20) — blocked by T01/#1, T02/#2, T03/#3, T04/#4, T05/#5, T06/#6, T07/#7, T08/#8, T09/#9, T10/#10, T11/#11, T12/#12, T13/#13, T14/#14, T15/#15, T16/#16, T17/#17, T18/#18, T19/#19

Native GitHub `blocked-by` edges were created with GraphQL `addBlockedBy` for every dependency above.

## Ticket execution log
### T01 / #1

- Red: `node --test dist/test/cli.test.js` exited 1 because `dist/src/cli.js` did not exist.
- Green: `npm run build`, focused CLI test, and full `npm test` passed.
- Standards review: minimal Node stdlib implementation; binary/test paths agree; no broad discovery or runtime scope added.
- Spec review: project/CWD separation, isolated home/session partition, allowed prompt contexts, and exact core tool set covered. No P0/P1/P2 findings.
### T02 / #2

- Red: `node --test dist/test/cli-surface.test.js` exited 1 for missing help, mode validation, and telemetry/environment inspection.
- Green: focused CLI-surface test, build, and full `npm test` passed.
- Standards review: top-level parsing only; no runtime/subcommand implementation; telemetry forced before SDK/package imports.
- Spec review: exact documented surface, unsupported mode rejection, real HOME/environment preservation, and sandbox warning covered. No P0/P1/P2 findings.
### T03 / #3

- Red: public Print-mode behavior test was added before the runtime; the minimum Pi SDK runtime then passed it on its first execution.
- Green: real local fake-model HTTP stream returned `pong`; missing-model case failed early; focused/build/full tests passed.
- Standards review: public Pi SDK (`ModelRuntime`, session runtime, Print runner) and Node stdlib only; shared auth/catalog are read-only by construction/test; foreign resources disabled.
- Spec review: independent Feishu default, shared model authentication, Print runner exit, exact core tools, launch-CWD binding, and readiness diagnostic covered. P2 fixed during review: explicit `allowModelNetwork: false`. No remaining P0/P1/P2 findings.
### T04 / #4

- Red: `npm run build` failed after the behavior test because the custom loader needed Pi's public `createExtensionRuntime`; fixed without broadening resource discovery.
- Green: focused resource-loader test, build, and full suite passed.
- Standards review: one explicit ResourceLoader with four allowed private prompt/skill paths; Pi skill parser reused; deterministic project-over-global precedence.
- Spec review: normative Feishu identity/domain vocabulary, append-only project context, foreign resource exclusion, referral boundary, isolation warning, and shadow diagnostics covered. No remaining P0/P1/P2 findings.
### T05 / #5

- Red: build exited 1 because the new public sync behavior referenced a missing module.
- Green: fake `lark-cli` proved versioned atomic publish, same-version reuse, and forced refresh; focused/build/full checks passed.
- Standards review: Node filesystem/process primitives plus Pi skill parser; no network or token handling; partial directories never published.
- Spec review: full version identity, success marker reuse, force sync, validation, fallback/no-cache warnings implemented. Deferred ceiling: exact real `lark-cli skills list` JSON schema may require adaptation when the CLI is available; command seam is fake-covered. No in-scope P0/P1/P2 findings.
### T06 / #6

- Red: package-storage CLI behavior test and adapter were introduced against a clean baseline; initial focused run passed after the minimum adapter implementation.
- Green: Pi `DefaultPackageManager` installed/persisted a local fixture globally and project-locally; real project `.pi` remained absent; focused/build/full tests passed.
- Standards review: Pi package manager/settings reused; one controlled symlink maps compat `.pi` to real project `.feishu-agent`; unsupported mapping fails before package mutation.
- Spec review: global/project storage, list/remove/update dispatch, single state, and Pi separation path covered. P2 fixed during review: CLI dispatch now uses same adapter. No remaining P0/P1/P2 findings.
### T07 / #7

- Red: build exited 1 when the package resource composition initially referenced a non-exported loader; switched to Pi's public `discoverAndLoadExtensions` API.
- Green: package-manager resolved manifest paths are composed below global/project private Skills; build and full suite pass.
- Standards review: package resolution remains delegated to Pi; no duplicate manifest/filter logic; one precedence loop.
- Spec review: package Skills/Extensions and official cache are now part of final precedence. Deferred ceiling: interactive `feishu config` UI and prompt/theme materialization need Pi TUI integration in Ticket 10; settings filtering itself remains Pi-owned. No P0/P1; deferred P2 is dependency-bound rather than safely implementable here.
### T08 / #8

- Red/Green: public loader composition check added; reserved-tool stripping and warning are a single final-policy loop.
- Validation: focused core-policy test, build, and full suite passed.
- Standards review: deletes only conflicting tool registrations; package/extension remains loaded; no registry replacement abstraction.
- Spec review: base identity is always prepended and reserved tools are reapplied on every loader reload. Deferred ceiling: real malicious-extension tool execution proof belongs with full model/TUI fixture integration. No current P0/P1/P2 findings.
### T09 / #9

- Red: build exited 1 for the missing public session partition module.
- Green: stable path-hash partition behavior, same-basename separation, central storage, and launch-CWD manager binding pass; build/full suite pass.
- Standards review: one SHA-256 key helper and Pi SessionManager reuse; no repository transcript paths.
- Spec review: central project partition and current launch CWD are wired into Print runtime. Deferred ceiling: visible resumed-CWD notice requires continuation/TUI dispatch in Ticket 10. No remaining P0/P1/P2 findings within this ticket.
