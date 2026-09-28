# Feishu Subagents

The optional [pi-subagents Feishu fork](https://github.com/Azhi-ss/pi-subagents-feishu)
reuses upstream agent definitions, workflows, foreground/background execution,
supervision, cancellation and result delivery. It is maintained separately from
Feishu Agent and does not modify the Pi SDK or Mem0 package.

## Local installation

Use the adapted checkout together with a Feishu Agent build containing the host
adapter. From the fork directory:

```bash
npm ci
feishu install /absolute/path/to/pi-subagents-feishu
```

Restart Feishu after installation or source changes. A local package registration
references that directory; it neither copies the checkout nor installs its npm
dependencies. Add `-l` to register only for the current Feishu Project. Installation
does not start a task, and `feishu init` does not install this optional package.

Ask Feishu to delegate a task in ordinary language. The upstream extension exposes
its existing tools and commands, including `/subagents-guide`. Its native `fresh`
and `fork` context semantics remain available.

For Lark retrieval, the bundled `delegate` role already has Bash and file tools:
“Use a delegate subagent to find this project's recent meeting conclusions;
return a short summary with source links.” The upstream `researcher` role is for
web research and requires its separately configured web tools.

## Feishu boundaries

- Every native child receives the parent's complete, already resolved Skill
  catalog, including private/package Skills and the selected official cache.
  Same-name precedence is unchanged; Skill bodies remain loaded on demand.
- Definitions and settings come from Feishu private roots. Ordinary `.agents/`,
  `.pi/`, Codex/Claude resources and global npm packages are not discovered.
- The host supplies its Feishu identity, read-only model authentication paths and
  destructive-command Guard. A model-written child task does not grant destructive
  authorization; the original parent input determines the inherited approval.
- Children do not automatically start the parent's Mem0 or Remote Bridge extensions.
  Native children run without interactive lark confirmation, so an unapproved
  destructive command fails promptly.
- External CLI/job runners and remote-machine placement are unavailable in Feishu
  mode because they do not run through this resource/policy boundary.

The host publishes immutable resource/approval snapshots beneath
`~/.feishu-agent/subagents/contexts/`. They contain resolved Skill metadata and the
system prompt, never model credentials or a copied user conversation. Detached
children retain their launch snapshot even if a later parent turn changes approval
or resources. These files have the same privacy expectations as Feishu sessions.
Runtime state stays in the private Feishu Home; private project configuration
remains under `<project>/.feishu-agent/`.

The integration uses `FEISHU_SUBAGENT_HOST_MODULE` and
`FEISHU_SUBAGENT_CONTEXT` internally. Feishu sets these itself; users do not need
to configure them. Missing or invalid host context is an error, not permission to
fall back to ordinary Pi discovery. This is resource isolation, not an OS sandbox.

## Validation

The cross-repository integration test runs real Feishu CLI processes, installs
the local fork, and uses temporary homes plus fake Lark/model services:

```bash
npm run build
FEISHU_SUBAGENTS_PACKAGE=/absolute/path/to/pi-subagents-feishu \
  node --test dist/test/subagents-runtime.test.js
```

Run the fork's focused Feishu tests and upstream tests as well when changing the
adapter. No live Feishu account or provider credentials are needed for these tests.

The host CI pins the fork to a reviewed commit and runs this contract on Node 22
and 24. It also checks the fork's types and full unit suite on Node 22, and repeats
the contract against the compiled package on Node 24. Update the pinned commit in
`.github/workflows/ci.yml` when adopting a new fork revision.
