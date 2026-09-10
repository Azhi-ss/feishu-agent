# Unattended runs rely on prompt-level guards, not a hard read-only tool policy

## Revision: managed Automation Jobs

For SPEC §16.5, the owner chose task prompts and workspace standing instructions
instead of the proposed hard per-action/target authorization or restricted
toolset. Retain existing tools, Skills, the turn-scoped high-risk guard, and
credential protections. The approved plan names fixed targets and identities:
bot for ordinary messages, user for appending to existing documents. These are
behavioral instructions, not an enforced permission boundary; model mistakes
and prompt injection can still cause out-of-plan writes.

This revises the earlier interview's code-policy prerequisite for these jobs,
including ordinary messages to already accessible groups. The trade-off is less
implementation and policy-maintenance code, not proof that stronger models
cannot overstep. Timing, concurrency, timeouts, and run accounting remain code
responsibilities. No implementation or deployment is authorized by this note.
The existing Briefing deployment and the separate Sweep/Alert milestones and
their enablement gates are unchanged.

## Original Briefing v0 decision

Unattended runs can read untrusted content (group-chat messages, at-mentions,
document titles) and then act with the owner's local and Feishu permissions.
We considered adding a code-level read-only guard for unattended runs
(allow-list of read commands plus a single write egress: posting the Briefing
to the owner's bot 1-on-1). We decided **not** to build it for v0 and to rely
on:

1. the existing turn-scoped high-risk guard (a destructive
   `delete/remove/revoke/withdraw` command cannot carry `--yes`, because the
   fixed unattended prompt never expresses destructive intent);
2. explicit read-only policy in the Automation Workspace `AGENTS.md`, naming
   the owner 1-on-1 as the only permitted write target.

Rationale accepted by the owner: v0's only action is sending one digest to the
owner himself; a command-policy layer is real code and testing surface, and
the workspace prompt plus the existing destructive-command guard are judged
sufficient for that single egress. Keeping v0 policy-only also leaves the
normal full toolset available while the workflow is being discovered.

Known cost, recorded deliberately: this enforcement is prompt-level, and
Briefing input contains attacker-influenced text — a direct or indirect prompt
injection telling the agent to post elsewhere or perform a non-`--yes` write
is a real (not theoretical) attack surface. Non-destructive writes without
`--yes` are not blocked by the existing guard.

## Upgrade trigger

Move to a hard unattended command policy (read allow-list + single write
egress) before any of: Sweep gaining write actions, Alert escalation, bot
membership in any group chat, or any observed out-of-policy tool call. The
change is local (a launch-mode command-policy editor) and requires no redesign.
