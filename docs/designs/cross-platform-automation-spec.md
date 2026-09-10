# PRD: Cross-platform, Agent-managed cron automation

## Problem Statement

The owner alternates between macOS and Linux/WSL and wants to tell Feishu Agent what to do and when, rather than hand-write scheduler configuration for each new task. The current application can execute a fresh unattended Print run, but it has no implemented task-management or scheduling surface. The earlier systemd-only proposal exposes Linux-specific calendar syntax and fails on macOS.

Closing the conversation must not discard approved tasks or prevent their execution on an awake host. At the same time, the owner wants a small, understandable addition—not a new chat gateway, permission engine, restricted toolset, or always-thinking agent. The final interview decision is to use prompts for business-action constraints while retaining existing protections and deterministic scheduling code.

## Solution

Provide one local automation capability with identical task definitions and management commands on macOS and Linux. Feishu Agent uses a private Feishu Skill and its existing Bash tool to prepare self-contained Automation Jobs, show the plan, obtain confirmation, and invoke the management CLI. No additional scheduler plugin installation is required beyond the shipped capability.

An explicitly enabled lightweight Trigger persists independently of chat windows. It evaluates calendar cron, one-shot, and fixed-interval Automation Schedules, then starts a fresh, memory-less Feishu Print process for each admitted Automation Run. The model does the Feishu work using existing tools and Skills; the Trigger handles timing, overlap, concurrency, deadlines, and run records.

The owner chooses one execution host per job. Definitions are portable, but synchronization, automatic handover, and cross-host duplicate suppression are not included. An asleep, powered-off, logged-out-without-a-running-service, or stopped WSL host cannot execute on time; bounded catch-up handles eligible missed occurrences after service recovery.

## User Stories

1. As a Feishu user, I want to describe a task and its timing in natural language, so that I do not need to write scheduler configuration.
2. As a Feishu user, I want the assistant to write a self-contained task instruction, so that execution does not depend on remembering the creation conversation.
3. As a macOS and Linux user, I want the same task format and management commands on both systems, so that switching platforms does not require relearning automation.
4. As a user, I want each job to execute on one selected host, so that its location and availability are clear.
5. As a user, I want to reuse a job definition on another supported host through explicit setup, so that portability does not silently enable duplicate schedules.
6. As a user, I want to inspect the complete plan before enabling it, so that timing, content, destinations, and identities can be corrected.
7. As a user, I want all execution-affecting edits to require renewed confirmation, so that approval of an old plan does not authorize a different plan.
8. As a user, I want approved recurring runs to proceed without asking again, so that unattended execution is actually useful.
9. As a user, I want invalid or incomplete CLI input rejected before task or service changes, so that a malformed request cannot leave a half-installed automation.
10. As a user, I want duplicate job names rejected rather than overwritten, so that existing work is not silently replaced.
11. As a user, I want to list jobs and their next scheduled times, so that I can see what will happen without reading implementation files.
12. As a user, I want to inspect a job's instructions, timing policy, and recent runs, so that I can audit its behavior.
13. As a user, I want to pause and resume a job, so that I can suspend future execution without losing its definition.
14. As a user, I want to explicitly stop a current run, so that I can interrupt unwanted or stuck work without confusing this with schedule management.
15. As a user, I want to remove a job without silently erasing its history, so that I can retain evidence of previous execution.
16. As a user, I want permanent removal of retained job artifacts to be explicit, so that routine removal is reversible at the information level.
17. As a user, I want to run a job manually through the same execution path as scheduling, so that testing reflects what will actually happen later.
18. As a user, I want calendar recurrence such as weekday mornings, so that routine summaries arrive on the intended dates.
19. As a user, I want a one-shot task at a specified time, so that a reminder does not accidentally recur.
20. As a user, I want true fixed elapsed-time intervals, so that every 90 minutes is not misrepresented by a cron minute-field step.
21. As a user, I want minute-level scheduling with no false second-accuracy promise, so that timing expectations match the feature.
22. As a user, I want Beijing time as the default and an explicit per-job timezone, so that system timezone changes do not shift my jobs.
23. As a user, I want the timezone and next occurrence shown at confirmation and creation, so that a bare statement such as nine o'clock is not ambiguous.
24. As a user, I want fixed intervals anchored at first enablement, so that execution duration and Trigger restarts do not continually shift the schedule.
25. As a laptop user, I want missed recurring work to catch up within a configurable window, so that short sleep periods do not unnecessarily lose useful work.
26. As a user, I want the default lateness window to be two hours, so that long delays do not produce stale work indefinitely.
27. As a user, I want recurring catch-up to execute at most the latest missed occurrence, so that recovery does not replay days of backlog.
28. As a user, I want an option to disable recurring catch-up, so that time-sensitive routines may skip missed occurrences.
29. As a user, I want a missed one-shot to expire after its lateness window, so that an obsolete reminder is not executed days later.
30. As a user, I want expired jobs retained with a distinct status, so that expiry is not confused with success, failure, or deletion.
31. As a user, I want at most one active run of the same job, so that concurrent triggers do not duplicate notifications or file work.
32. As a user, I want occurrences arriving during an active same-job run skipped without queuing, so that slow execution cannot build a backlog.
33. As a user, I want manual execution to respect the same overlap rule, so that manual testing cannot start a duplicate copy.
34. As a user, I want up to two different jobs to execute concurrently, so that one slow report does not block every other task.
35. As a user, I want capacity-waiting work to retain its original lateness deadline, so that waiting for a slot does not authorize stale execution.
36. As a user, I want a ten-minute default execution timeout that can be changed per job, so that stuck work is bounded without forbidding longer reports.
37. As a user, I want failures and uncertain outcomes recorded without automatic whole-job retries, so that recovery does not blindly repeat external writes.
38. As a user, I want later normal occurrences to continue after a failed run, so that one failure does not silently disable a recurring job.
39. As a user, I want partial work and unconfirmed delivery described honestly, so that process completion is not mistaken for guaranteed business success.
40. As a user, I want a fresh Print process for every run without Mem0, so that long-lived chat context and automatic memory capture are not part of automation.
41. As a user, I want existing Feishu Skills and tools reused, so that the assistant can perform real work without a second tool ecosystem.
42. As a user, I want task prompts to describe fixed actions, targets, identities, and error handling, so that approved business intent is explicit without a new permission engine.
43. As a user, I want automated ordinary messages sent as the bot to specified conversations, so that they are distinguishable from my personal messages.
44. As a user, I want append-only updates to specified existing documents made under my user identity, so that existing document workflows remain usable.
45. As a user, I want instructions to forbid identity fallback or automatic group joining when access fails, so that failed access does not expand the intended task.
46. As a user, I want existing high-risk confirmation and credential protections preserved, so that adding automation does not remove established safeguards.
47. As a user, I want explicit Trigger start, stop, and status operations independent of chat, so that I can control whether background scheduling is running.
48. As a user, I want normal Interactive, Print, and initialization entry points not to install or start the Trigger, so that opening Feishu does not silently enable a service.
49. As a user, I want useful local run records retained for 30 days without credential copies, so that diagnosis is possible without unnecessary secret exposure.
50. As a user with an existing Briefing deployment, I want it left untouched, so that the new capability does not change its policy or send duplicate briefings.
51. As a maintainer, I want identical external-behavior tests on macOS and Linux with fake services, so that compatibility is demonstrated without real Feishu actions.
52. As a maintainer, I want tests to distinguish prompt inclusion from guaranteed model compliance, so that the feature does not claim a security property it does not implement.

## Implementation Decisions

### Architecture and capability delivery

- Build a small Automation module behind the existing CLI. It owns job management, due-occurrence evaluation, local dispatch coordination, and run records. Reuse the existing unattended Print runner, resource loading, and default-Skill installation mechanisms rather than copying an Agent Runtime.
- Ship a private Feishu automation Skill that teaches the model to prepare, inspect, confirm, create, update, and manage jobs through the CLI using existing Bash. Install it idempotently through the existing explicit initialization flow, including existing homes that are missing it; never overwrite a user-edited copy. No new model tool, Extension lifecycle loop, remote API, or separately installed automation Package is required.
- Use one application-level Trigger with shared scheduling logic on macOS and Linux. It is a timer/dispatcher, not a chat gateway or retained model session. OS service integration supervises this one process: launchd on macOS and user systemd on supported Linux/WSL. It does not translate every job into an OS schedule or modify the user's crontab.
- Provide explicit service start, stop, status, and a foreground serve entry. First service start performs local prerequisite validation and owned-service installation; stopping disables background restart without removing jobs. Ordinary chat, Print, and initialization do not install, start, wait for, or probe a scheduler service. Existing explicitly requested initialization operations retain their current behavior; this feature adds no startup networking.
- Foreground serve remains usable where a supported OS lacks a suitable user-service manager; service operations fail with an actionable error before partial installation. A foreground process must remain alive. No automatic linger, root installation, login changes, or host wake configuration is introduced.
- Keep the normal tools and Skills, including Bash and local file tools. The owner's final decision explicitly rejects a new per-action/target permission engine, restricted toolset, or sandbox. Validation of scheduler inputs and local state is ordinary correctness, not a new business-authorization system.
- Preserve dependency pinning and the repository's no-new-dependencies policy. This PRD does not approve a scheduler framework, a dependency upgrade, or third-party patching.

### Public management contract

- Extend the automation CLI family with list, show, add, update, run, pause, resume, cancel-current-run, and remove operations, plus Trigger start, stop, status, and serve. Keep human chat intent interpretation in the Skill; do not implement a natural-language parser or an additional slash-command family in the CLI.
- Creation requires a safe unique name, exactly one schedule kind, and nonempty task instructions supplied by file or stdin. Optional values cover timezone, catch-up window, and execution timeout. Updates preserve unspecified values and validate the complete resulting plan. Malformed values, conflicting schedule kinds, unsupported options, and duplicate names fail before mutation.
- Add and execution-affecting update operations show the complete proposed plan or change. Interactive CLI invocation requires affirmative confirmation. Noninteractive invocation requires an explicit confirmation flag and otherwise fails promptly. The Skill must show the plan and receive the owner's confirmation before making that driven call. This flag is an attestation by the caller, not proof that a human was present or a cryptographic authorization grant.
- Creation records the resolved nonsecret Lark profile with the job and includes it in confirmation and inspection. Resolve it from the existing explicit profile selector, then the invocation's profile environment, then lark-cli's locally configured default (including its unnamed default if applicable); if it cannot be resolved locally, fail with guidance to select a profile explicitly. Scheduled and manual runs use the saved selection rather than the Trigger or caller's current default. Changing it uses the existing selector on a confirmed update; credentials remain owned by lark-cli.
- Confirmation covers task instructions, timing and timezone, next due time, named actions and destinations, execution identity, and timing policies. Business-action details remain readable instructions; the CLI does not parse them into an ACL. Creation does not perform a real trial send automatically; explicit manual run is the test entry.
- An approved job may be stored while the Trigger is stopped. The receipt must distinguish an enabled schedule from a running Trigger and must not claim reliable future execution when the service is inactive.
- Structured automation command results go to stdout, with English diagnostics and interactive confirmation on stderr. This is command output, not a new global JSON/RPC Agent mode. No exact storage serialization or private fields become part of the response contract.
- List and show expose job state, schedule kind and value, timezone, catch-up and timeout policy, next due time, latest outcome, and available recent run records. Status also reports whether the Trigger is actually active; do not derive liveness from an installation file alone.

### Schedule and execution semantics

- Calendar recurrence uses a portable numeric five-field cron grammar at minute resolution, supporting wildcards, lists, ranges, and steps. Document day-of-month/day-of-week OR semantics when both are restricted. Seconds fields, native systemd expressions, provider-specific macros, and advanced cron extensions are out of scope; invalid expressions fail rather than being approximated.
- Every job stores an explicit IANA timezone, defaulting to Asia/Shanghai. Calendar recurrence and offset-less one-shot times use that zone. Explicit-offset one-shot timestamps identify an absolute instant. Fixed elapsed intervals do not change with timezone. Creation resolves relative natural-language times into the absolute or recurring definition shown to the user.
- Fixed intervals start one interval after first enablement and retain that anchor across normal runs and Trigger restarts. Execution duration does not shift subsequent occurrences. Changing the interval establishes a newly confirmed schedule anchor; pause/resume of an unchanged schedule preserves the existing anchor.
- Recurring jobs default to a two-hour lateness window, adjustable per job or disabled. On recovery, coalesce missed occurrences to at most the latest eligible one; do not replay the backlog. A missed one-shot uses its own adjustable two-hour default and becomes expired if its window elapses before execution begins. Expiry retains the job and is not execution failure.
- A due occurrence already running, completed, skipped for overlap, failed, timed out, cancelled, or of uncertain outcome is not eligible for automatic catch-up. Recovery must consult durable dispatch/run state rather than treating every old due time as never started.
- Same-job execution is exclusive across scheduled and manual calls. When a scheduled occurrence arrives during an active same-job run, record a skip and do not queue it. A manual same-job request while active returns an already-running error.
- Admit at most two different Automation Runs per local managed workspace, including manual runs. Other scheduled work waits for capacity without extending its lateness deadline. Keep at most the latest not-started occurrence per waiting recurring job; reevaluate before dispatch rather than maintaining an unbounded backlog.
- Default execution timeout is ten minutes from actual run start and is configurable per job; waiting time is not charged to it. Stop the owned execution on timeout and retain the timeout outcome. The slot is not considered free until the owned process has actually ended. Do not signal unrelated processes based solely on a stale PID.
- Started jobs are not automatically rerun on failure, timeout, interruption, or uncertainty. Later normal recurring occurrences remain enabled. A one-shot is consumed once its scheduled dispatch begins and is not automatically dispatched again after a failed attempt. A new explicit manual run is a separate attempt and must make potential duplicate external effects clear when relevant.
- Completed means the runner finished successfully, not that Feishu guaranteed every intended write. Retain the result and diagnostics; distinguish confirmed failure, timeout, cancellation, expiry, overlap skip, and interrupted/unknown outcome. Do not turn a model's assertion or missing receipt into proof of delivery or non-delivery.

### Task instructions, identity, and existing protections

- Every job instruction is self-contained and describes the objective, needed inputs, fixed destinations, allowed actions, identities, expected result, and what to do when data or access is unavailable. Do not copy the whole creation transcript or rely on interactive memory.
- First-version task policy allows ordinary messages to fixed conversations as bot and append-only content to fixed existing documents as the owner user. It tells the model not to switch identities, choose new destinations, create replacement documents, join groups, alter membership/permissions, process approvals, issue urgent notifications, or perform destructive operations.
- The approved plan and workspace standing instructions carry these business constraints. Prompt injection and model mistakes can still cause out-of-plan behavior because the underlying tools remain available. Do not build ACL parsing, per-target tokens, a dedicated controlled-send API, or an unattended tool allow-list under the guise of implementing this PRD.
- Preserve the existing turn-scoped high-risk guard without broadening its approval parser. Do not append artificial destructive approval to scheduled prompts. Preserve noninteractive fast failure when an operation would require confirmation.
- Retain a narrow recursion check in the automation management entry: inherited unattended execution cannot invoke job-management or service-management commands to reproduce or mutate its schedules. The Trigger starts Print children directly rather than needing a public management bypass. With general Bash still available, this check is loop prevention, not an OS security boundary.
- Each Automation Run is a new memory-less Print process in the managed Automation Workspace, with no continuation of a previous model session and no Mem0 recall, capture, or dream. The workspace instructions remain the explicit personalization source.
- Reuse model credentials read-only and let lark-cli own its login state. Job definitions, service configuration, logs, and sessions must not contain copied credentials. Do not persist a shell environment snapshot or inject Mem0/Remote Bridge secrets into scheduled children. Preserve the selected nonsecret Lark profile and the real user Home; the job instruction specifies user versus bot explicitly.

### Persistence, lifecycle, and implementation defaults

The following are small engineering defaults for details delegated by the owner, not additional interview choices.

- Use local, versioned JSON job records and task text, with atomic replacement and bounded local coordination. Store schedule state separately from run history and keep enough durable occurrence identity to avoid redispatch after restart or clock rollback. Do not introduce a distributed store or workflow database framework.
- Use a dedicated managed Automation Workspace separate from the already deployed hand-built Briefing policy and artifacts. Never overwrite the existing Briefing instructions, read/modify its scheduler units, or migrate it automatically. Managed tasks do not inherit the project from which the creation chat happened.
- An explicit first setup may seed missing managed-workspace standing instructions. Existing user-edited managed instructions and Skills are not silently overwritten. Model-driven scratch artifacts should use a per-run area inside that workspace to avoid collisions between different jobs.
- Pause stops future admission and discards not-started pending occurrences; current execution continues. Cancel stops a named active run without pretending earlier writes were rolled back. The Skill maps the user's intent to these distinct operations. Resume does not replay the intentionally paused period and reports the next occurrence; an overdue one-shot whose window has passed stays expired.
- Apply approved updates atomically to future runs; a currently running attempt retains the plan snapshot it started with. The old plan remains active while an edit awaits confirmation unless the owner explicitly pauses it. Content-only changes do not reset timing anchors.
- Remove disables future execution and retains task/history artifacts by default. Refuse removal of an active run with guidance to pause or cancel first. Explicit purge removes retained artifacts. Do not reuse a retained name silently or delete unrelated files.
- Manual execution need not require an always-running Trigger, but uses the same admission and execution path and shared local locks. Retained paused, completed, or expired jobs may be run manually; removed jobs may not. A manual run does not consume or re-arm a one-shot schedule, change its expiry state, or shift recurring timing. Its receipt warns if a future scheduled occurrence remains eligible. The standalone invocation owns and supervises its child until completion, including bounded termination or an unknown outcome on interruption. Trigger shutdown affects Trigger-owned executions, not independent manual runs; active manual runs still occupy shared capacity. Restart must not free still-live runs or replay uncertain ones.
- Clock and DST defaults: do not run before a due instant, do not replay already settled occurrences after clock rollback, skip nonexistent local calendar times, and treat an ambiguous repeated local calendar minute as one occurrence. One-shots with ambiguous or nonexistent offset-less local times fail with a request for an explicit offset instead of silently guessing. With catch-up disabled, normal dispatch within its due minute is allowed; a missed earlier minute is not replayed.
- Retain run output and diagnostics for 30 days; never prune active work or definitions as log cleanup. Preserve corrupt or unsupported-version records and report them without deleting evidence or automatically re-enabling jobs. Error reporting must not dump credential-bearing environment or command diagnostics.
- Service installation captures only the executable locations and nonsecret environment needed for noninteractive execution. Paths containing spaces and different Node/package-manager layouts must work on both OSes. Missing executables, inaccessible managed state, and unavailable service managers produce actionable errors without partially enabled services.

## Testing Decisions

The owner explicitly approved one primary test seam: real Feishu CLI subprocesses in temporary homes and workspaces, with fake lark-cli/service-manager executables and loopback fake model/Mem0 services. Tests assert observable results and effects, not private implementation fields or Pi internals.

1. **Management:** cover complete create/update confirmation flows, noninteractive refusal without the flag, no mutation on malformed input or declined confirmation, duplicate names, list/show, pause/resume, manual run, cancel, remove, and explicit purge. Verify profile binding survives changes to caller/service defaults and requires a confirmed update to change; verify manual runs of future, paused, completed, and expired one-shots leave the scheduled state unchanged and removed jobs are not runnable. Use existing CLI-surface and initialization test patterns as prior art.
2. **Schedules:** exercise each schedule kind, explicit/default timezone, fixed anchors, restart, clock rollback, DST boundaries, catch-up cutoff, recurring coalescing, one-shot expiry, and no catch-up. Drive the normal CLI/Trigger through one controlled test-clock fixture rather than waiting real minutes or hours; do not add public clock-control flags or a production test service.
3. **Admission and recovery:** block fake child work at known checkpoints to verify same-job exclusivity, scheduled/manual races, a two-job global limit, waiting deadlines, overlap skips, timeout, bounded shutdown, and crash-before/after-dispatch recovery. Count real subprocess starts and observe durable results; do not assert private queue internals.
4. **Execution:** use the established model-print and unattended-mode fixtures to prove a fresh Print session, correct instructions/workspace/profile, preserved normal tools, no Mem0 requests, no previous conversation leakage, recorded stdout/stderr/outcome, and honest failure/unknown statuses. Simulate a partial side effect followed by failure and assert that no whole-run automatic replay occurs.
5. **Skill workflow:** verify discovery, body loading, idempotent installation for fresh and existing homes, preservation of user edits, and scripted fake-model calls through Bash to the real CLI. The fixture can prove the instructed flow is connected; it cannot prove an arbitrary real model will always follow it.
6. **Prompt-only policy:** verify that fixed targets, action policy, and user/bot instructions reach the model and that the existing high-risk guard still blocks its documented cases. Do not write or claim tests proving universal non-escape, no unauthorized writes, or a new per-target security boundary.
7. **Service lifecycle:** fake launchctl/systemctl invocations and generated owned-service artifacts under temporary directories; verify explicit start/stop/status, platform selection, path quoting, rollback on failed setup, and no implicit scheduler activity during ordinary startup. Never change a real user service, crontab, login setting, or existing Briefing installation in automated tests.
8. **Secret and isolation regression:** use nonsecret sentinels to assert that managed definitions, service artifacts, sessions, output, and diagnostics do not copy Mem0 keys, Lark tokens, or Remote Bridge secrets. Reuse hermetic subprocess environments and existing release/isolation tests; no real account or network endpoints.
9. **Platform acceptance:** run the same automated behavior suite on macOS and Linux with Node 22 and 24. Existing Linux-only CI is prior art, not evidence of macOS compatibility. Preserve the existing full-test gate, clean-install checks when manifests change, and whitespace validation. Actual service-manager smoke testing, if separately authorized, is reported separately from hermetic tests.

## Out of Scope

- Cross-host synchronization, distributed claims, automatic failover, or deduplication between independent enabled installations.
- Windows-native services, new WSL lifetime guarantees, waking a sleeping host, or execution while the host is off.
- Per-job systemd/launchd calendars, user crontab editing, multiple scheduler backends, external webhook providers, or cloud scheduling infrastructure.
- An always-on model session, a chat gateway, a new Remote Bridge transport, public RPC/HTTP control, or autonomous self-scheduling from scheduled runs.
- A hard business-authorization engine, restricted toolset, sandbox, permission grants, or changes to the existing destructive-command guard.
- General-purpose shell-job products, no-model script scheduling, task dependency graphs, distributed queues, exact-once external delivery, automatic whole-job retries, or transactional rollback of Feishu writes.
- Arbitrary business writes beyond the two prompt-policy categories, dynamic write destinations, document replacement/deletion, approvals, permission/member changes, urgent messages, or automatic group joining.
- Copying secrets, changing authentication flows, automatic memory use, or importing resources from other agents.
- Automatic migration or modification of the existing Briefing, implementation/enablement of Sweep or Alert, and their separate rollout decisions.
- New scheduler UI, second-level schedules, advanced cron extensions, speculative configuration, or dependency changes without repository-policy approval.

## Further Notes

- This PRD replaces the systemd-only, no-Feishu-daemon proposal in #37. Fresh short-lived unattended execution remains; the ban on every resident Feishu process does not. The final prompt-only policy supersedes the interview's temporary proposal for hard authorization and restricted tools.
- The research distinction matters: OpenClaw and Hermes normally own cron timing in application processes, not per-job OS crontabs. Feishu adopts shared application timing and job-management UX without copying their gateways, provider abstractions, or full reliability machinery. Primary references: [OpenClaw scheduling](https://docs.openclaw.ai/automation/cron-jobs/how-it-works) and [Hermes cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron/).
- The preexisting Briefing and future Sweep/Alert specifications describe separate deployments and authorization decisions. They are not implementation blockers for this managed-job capability and must not be silently activated or rewritten by it.
- The owner ended fine-grained interviewing and delegated remaining ordinary engineering choices. The implementation defaults above make those choices explicit without reopening the interview or adding a permissions project.
- This issue is a specification for later tracer-bullet implementation tickets. Publishing it does not implement the feature, authorize live Feishu writes, enable a service on the owner's machines, or certify platform acceptance already passed.
