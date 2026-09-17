import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture as initFixture, run, allFiles } from "./helpers/init-e2e-fixture.js";
import { hermeticEnv } from "./helpers/hermetic-env.js";
import { toolResponse, profileListJson } from "./helpers/automation-cli-fixture.js";
import { cli, createTriggerHarness, startGateServer, gate, textResponse, DUE_MS, MIN, setClock, waitStarted, settle, stopServe, runCli, type Fixture } from "./helpers/automation-trigger-fixture.js";

const { gateServers, startServe } = createTriggerHarness();
const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

// Real TUI input, with each owner reply sent once after the preceding plan/receipt.
function conversation(cwd: string, env: NodeJS.ProcessEnv, actions: Array<{ wait: string; send: string }>) {
  const driver = `import json,os,pty,select,sys,time
steps=json.loads(sys.argv[3]); pid,fd=pty.fork()
if pid==0:
 os.chdir(sys.argv[1]); os.execvpe(sys.argv[2],[sys.argv[2],sys.argv[4]],os.environ)
out=b''; checkpoint=0; step=0; deadline=time.time()+90
while time.time()<deadline:
 ready,_,_=select.select([fd],[],[],0.1)
 if ready:
  try: out+=os.read(fd,65536)
  except OSError:
   _,status=os.waitpid(pid,0); sys.stdout.buffer.write(out); sys.exit(os.waitstatus_to_exitcode(status) if step==len(steps) else 125)
 if step<len(steps) and steps[step]['wait'].encode() in out[checkpoint:]:
  time.sleep(.2); os.write(fd,steps[step]['send'].encode()); checkpoint=len(out); step+=1
 child,status=os.waitpid(pid,os.WNOHANG)
 if child:
  sys.stdout.buffer.write(out); sys.exit(os.waitstatus_to_exitcode(status) if step==len(steps) else 125)
os.kill(pid,15); sys.stdout.buffer.write(out); sys.exit(124)`;
  return new Promise<{ code: number | null; output: string }>((done, reject) => {
    const child = spawn("python3", ["-c", driver, cwd, process.execPath, JSON.stringify(actions), cli], { env });
    let output = "";
    child.stdout.on("data", (chunk) => output += chunk);
    child.stderr.on("data", (chunk) => output += chunk);
    child.once("error", reject);
    child.once("close", (code) => done({ code, output }));
  });
}

test("scripted conversation reads private Skill, confirms create/edit, manages the real CLI and observes manual/scheduled memory-less Print", async () => {
  const init = await initFixture();
  const model = await startGateServer();
  gateServers.push(model.server);
  const f: Fixture = { root: init.project, home: init.home, bin: join(init.root, "bin"), jobs: join(init.root, "jobs"), clockFile: join(init.root, "clock.json"), model };
  const serviceLog = join(init.root, "services.log");
  const effects = join(init.root, "effects.log");
  const token = "LARK-TOKEN-SENTINEL-44";
  const remoteSecret = "REMOTE-SECRET-SENTINEL-44";
  const env = hermeticEnv({ HOME: f.home, PATH: init.env.PATH, PI_OFFLINE: "1", TERM: "xterm-256color", COLUMNS: "160", LINES: "50",
    FEISHU_UNATTENDED: "0", FEISHU_REMOTE: "0", MEM0_API_KEY: init.secret, MEM0_API_HOST: init.env.MEM0_API_HOST,
    FEISHU_AUTOMATION_HOME: f.jobs, FEISHU_AUTOMATION_CLOCK_FILE: f.clockFile, LARK_PROFILE: "approved-profile" });
  setClock(f, DUE_MS - 10 * MIN);
  for (const command of ["systemctl", "launchctl"]) writeFileSync(join(f.bin, command), `#!/bin/sh\necho unexpected >> ${quote(serviceLog)}\nexit 1\n`, { mode: 0o755 });
  const briefing = join(init.home, "feishu-automation", "AGENTS.md");
  mkdirSync(join(init.home, "feishu-automation"), { recursive: true });
  writeFileSync(briefing, "LEGACY-BRIEFING-UNCHANGED\n");
  try {
    const initialized = await run(f.root, env, ["init", "--identity", "alice", "--model", "fake/fake-model"]);
    assert.equal(initialized.code, 0, initialized.stderr);
    // Keep the real Mem0 package configured: unattended runs must skip it, not just
    // happen to have no package. Only the fake model's endpoint/catalog is replaced.
    writeFileSync(join(init.pi, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.port}/v1`, api: "openai-completions", models: [{ id: "fake-model", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 4096 }] } } }));
    writeFileSync(join(f.bin, "feishu"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`, { mode: 0o755 });
    const profiles = profileListJson([["approved-profile", true], ["changed-default", false]]);
    const messageCommand = "lark-cli im +messages-send --chat-id oc_fixed --text 'Approved report' --as bot";
    const appendCommand = "lark-cli docs +update --doc doc_existing --command append --content '<p>Approved report</p>' --as user";
    writeFileSync(join(f.bin, "lark-cli"), `#!/bin/sh
case "$1 $2" in
 "profile list") printf '%s' '${profiles}' ;;
 "--version ") echo 'lark-cli 9.9.9' ;;
 "im +messages-send"|"docs +update")
  printf '%s|%s|%s|%s|%s|%s\\n' "$LARK_PROFILE" "$FEISHU_UNATTENDED" "\${MEM0_API_KEY:+LEAK}" "\${FEISHU_REMOTE_APP_SECRET:+LEAK}" "$HOME" "$*" >> ${quote(effects)}
  printf '{"ok":true,"receipt":"fake-effect-receipt"}' ;;
 *) echo 'unexpected lark command' >&2; exit 2 ;;
esac
`, { mode: 0o755 });
    const larkConfig = join(f.home, ".config", "lark-cli");
    mkdirSync(larkConfig, { recursive: true });
    writeFileSync(join(larkConfig, "config.json"), JSON.stringify({ token }));
    const skillPath = join(init.agentHome, "skills", "feishu-automation", "SKILL.md");
    const taskPath = join(f.root, "report-task.md");
    const task = `Objective: publish the approved report. Inputs: the literal Approved report text.
Fixed destinations: conversation oc_fixed and existing document doc_existing.
Actions/identities: ordinary message as bot; append-only existing-document update as user.
Output: report write receipts and partial completion; use per-run scratch only.
Access/data failure: report unavailable credentials or sources, never identity fallback,
new destinations, replacement documents, group joining, permission/member changes,
approvals, urgent escalation or destructive edits. No whole-job retry or schedule management.
No memory recall or conversation history needed.\n`;
    const editedTask = task + "Include the approved source label REVISION-TWO in the run summary.\n";
    const fullPlan = (body: string, time: string) => `Job report; host this test host; one-shot ${time}+08:00; Asia/Shanghai; next ${time.replace("09:", "01:")}Z. Profile approved-profile; ordinary bot message oc_fixed; user append doc_existing. Lateness 2h; timeout 10m; two-job capacity, same-job exclusion; no automatic whole-job retry. Prompt-only policy, not a sandbox. Host and Trigger must stay alive. Task:\n${body}`;
    const bash = (command: string, id: string) => toolResponse("bash", { command }, id);
    const replies = [
      toolResponse("read", { path: skillPath }, "skill-read"),
      toolResponse("write", { path: taskPath, content: task }, "prepare-task"),
      textResponse(fullPlan(task, "2030-06-01T09:00:00") + "\nConfirm this complete plan? CREATE-PLAN-READY"),
      bash(`feishu automation add --name report --at 2030-06-01T09:00 --prompt-file ${quote(taskPath)} --lark-profile approved-profile --yes`, "create"),
      bash("feishu automation show report", "inspect-create"),
      textResponse("Saved report, enabled; next 2030-06-01T09:00+08:00 / 01:00Z Asia/Shanghai, profile approved-profile, 2h lateness, 10m timeout. Trigger inactive: no automatic firing until separately approved automation start. No trial write. Use automation show/list/status, pause or explicit run. CREATE-SAVED"),
      bash("feishu automation show report", "inspect-before-edit"),
      toolResponse("write", { path: taskPath, content: editedTask }, "prepare-edit"),
      textResponse("Old 09:00 -> new 09:05; summary adds REVISION-TWO. Old plan remains active until approved. " + fullPlan(editedTask, "2030-06-01T09:05:00") + "\nConfirm this revised plan? EDIT-PLAN-READY"),
      bash(`feishu automation update report --at 2030-06-01T09:05 --prompt-file ${quote(taskPath)} --yes`, "edit"),
      bash("feishu automation show report", "inspect-edit"),
      textResponse("Updated report; enabled; next 2030-06-01T09:05+08:00 / 01:05Z Asia/Shanghai, approved-profile, 2h lateness, 10m timeout. Trigger inactive; show/status for inspection. EDIT-SAVED"),
      bash("feishu automation pause report", "pause"),
      textResponse("report paused: future dispatch stops, current attempt would continue. Cancel is separate and does not roll back writes. PAUSED-RECEIPT"),
      bash("feishu automation resume report", "resume"),
      textResponse("report resumed; next 2030-06-01T09:05+08:00 Asia/Shanghai; no replay of intentionally paused work. RESUMED-RECEIPT"),
      textResponse("Manual testing performs real writes and may duplicate effects: future one-shot remains eligible at 09:05 Asia/Shanghai. Confirm a separate run? MANUAL-PLAN-READY"),
      bash("feishu automation run report", "manual"),
      bash(messageCommand, "manual-message"), bash(appendCommand, "manual-append"),
      textResponse("REVISION-TWO: fake-effect-receipt for bot message and user append. RUN-FINISHED"),
      bash("feishu automation show report", "inspect-manual"),
      textResponse("Manual report completed with fake receipts; runner completion is not guaranteed delivery. The future one-shot remains eligible at 2030-06-01T09:05+08:00 Asia/Shanghai and may duplicate writes. Trigger still inactive. MANUAL-RECEIPT"),
    ];
    model.jobs.push(...replies.map((reply) => gate(reply)));
    const chat = await conversation(f.root, env, [
      { wait: "fake-model", send: "Prepare a scheduled report for oc_fixed and doc_existing at 09:00 Beijing time on June 1 2030, but ask before saving. PRIVATE-CHAT-ONLY\r" },
      { wait: "CREATE-PLAN-READY", send: "I explicitly confirm the complete report plan, targets, identities, profile and timing. Save only, do not activate a service or run it.\r" },
      { wait: "CREATE-SAVED", send: "Please propose changing report to 09:05 and add source label REVISION-TWO.\r" },
      { wait: "EDIT-PLAN-READY", send: "I explicitly confirm this revised complete plan. Apply the edit.\r" },
      { wait: "EDIT-SAVED", send: "Pause future dispatch of report.\r" },
      { wait: "PAUSED-RECEIPT", send: "Resume report.\r" },
      { wait: "RESUMED-RECEIPT", send: "Can I test report now?\r" },
      { wait: "MANUAL-PLAN-READY", send: "Yes, run report once now as a separate attempt; I understand the duplication risk.\r" },
      { wait: "MANUAL-RECEIPT", send: "/quit\r" },
    ]);
    assert.equal(chat.code, 0, chat.output);
    assert.equal(model.jobs.length, 0, "all scripted conversation steps were consumed");
    assert.equal(existsSync(serviceLog), false, "saving/editing/manual execution must not activate services");
    const payloads = model.requests.map((raw) => JSON.parse(raw));
    for (const [id, approval] of [["create", "I explicitly confirm the complete report plan"], ["edit", "I explicitly confirm this revised complete plan"], ["manual", "Yes, run report once now"]]) {
      const receiptRequest = payloads.find((payload) => payload.messages.at(-1)?.tool_call_id === id);
      assert(receiptRequest, `missing real CLI receipt for ${id}`);
      const ownerTurn = receiptRequest.messages.findLast((message: { role: string }) => message.role === "user");
      assert(JSON.stringify(ownerTurn).includes(approval), `${id} must follow the scripted owner's explicit confirmation`);
    }
    const skillResult = payloads[1].messages.find((message: { role: string }) => message.role === "tool");
    assert.match(JSON.stringify(skillResult), /Prepare → present → confirm → save → inspect/);
    for (const policy of [/--cron/, /--every/, /--at/, /Asia\/Shanghai/, /--purge/, /automation cancel/, /no-escape guarantee/, /PROMPT-ONLY/]) assert.match(JSON.stringify(skillResult), policy);
    // These are the real Bash tool receipts returned to the model, not its scripted prose.
    const tools = payloads.flatMap((payload) => payload.messages.filter((message: { role: string }) => message.role === "tool"));
    const toolText = tools.map((message: { content: string }) => message.content).join("\n");
    assert.match(toolText, /2030-06-01T01:00:00.000Z/);
    assert.match(toolText, /2030-06-01T01:05:00.000Z/);
    assert.match(toolText, /"state":\s*"paused"/);
    assert.match(toolText, /still in the future and remains eligible/);
    const initial = runCli(f, ["automation", "show", "report"]);
    assert.equal(initial.code, 0, initial.stderr);
    const shown = JSON.parse(initial.stdout);
    assert.equal(shown.task, editedTask.trim());
    assert.equal(shown.profile, "approved-profile");
    assert.equal(shown.nextDueAt, "2030-06-01T01:05:00.000Z");
    assert.equal(shown.state, "enabled");
    assert.equal(shown.triggerRunning, false);
    assert.equal(shown.recentRuns.length, 1);
    assert.equal(shown.recentRuns[0].trigger, "manual");

    // Explicit test-only foreground activation, not model-inferred activation.
    // Change both local and caller defaults: the saved profile must still win.
    const fakeLark = join(f.bin, "lark-cli");
    writeFileSync(fakeLark, readFileSync(fakeLark, "utf8").replace(profiles, profileListJson([["approved-profile", false], ["changed-default", true]])), { mode: 0o755 });
    const memoryBefore = init.memoryRequests.length;
    const scheduledIndex = model.requests.length;
    model.jobs.push(gate(bash(messageCommand, "scheduled-message")), gate(bash(appendCommand, "scheduled-append")), gate(textResponse("REVISION-TWO: fake-effect-receipt. SCHEDULED-FINISHED")));
    const serve = startServe(f, { LARK_PROFILE: "changed-default", MEM0_API_KEY: init.secret, MEM0_API_HOST: init.env.MEM0_API_HOST, FEISHU_REMOTE_APP_SECRET: remoteSecret });
    await waitStarted(serve);
    setClock(f, DUE_MS + 5 * MIN);
    assert.equal((await settle(f, "report")).outcome, "completed");
    assert.equal(await stopServe(serve), 0);
    assert.equal(init.memoryRequests.length, memoryBefore, "scheduled Print must not call Mem0");
    const scheduled = JSON.parse(model.requests[scheduledIndex]);
    assert.deepEqual(scheduled.messages.map((message: { role: string }) => message.role), ["system", "user"]);
    assert.match(JSON.stringify(scheduled), /oc_fixed[\s\S]*doc_existing/);
    assert.match(JSON.stringify(scheduled), /append-only/i);
    assert.match(JSON.stringify(scheduled), /no identity fallback/);
    assert.match(JSON.stringify(scheduled), /REVISION-TWO/);
    assert.doesNotMatch(JSON.stringify(scheduled), /PRIVATE-CHAT-ONLY|CREATE-PLAN-READY/);
    const trace = readFileSync(effects, "utf8").trim().split("\n");
    assert.equal(trace.length, 4, "one bot message and one user append per explicit run");
    for (const line of trace) assert(line.startsWith(`approved-profile|1|||${f.home}|`), line);
    assert.equal(trace.filter((line) => line.endsWith("im +messages-send --chat-id oc_fixed --text Approved report --as bot")).length, 2);
    assert.equal(trace.filter((line) => line.endsWith("docs +update --doc doc_existing --command append --content <p>Approved report</p> --as user")).length, 2);
    // An out-of-plan scripted model still hits the existing documented guard.
    // Both --yes without destructive user intent and noninteractive confirmation
    // fail; normal business-policy instructions are NOT a new target ACL.
    for (const suffix of [" --yes", ""]) {
      model.jobs.push(gate(bash(`lark-cli doc delete doc_existing --as user${suffix}`, `blocked-${suffix.length}`)));
      const failed = await run(f.root, { ...env, LARK_PROFILE: "changed-default" }, ["automation", "run", "report"]);
      assert.equal(failed.code, 1, failed.stderr);
      assert.equal(JSON.parse(failed.stdout).outcome, "failed");
      assert.equal(model.jobs.length, 0, "Print guard terminates the turn without another model request");
    }
    assert.equal(readFileSync(effects, "utf8").trim().split("\n").length, 4, "blocked destructive calls never reach fake lark-cli");
    assert.equal(init.memoryRequests.length, memoryBefore, "manual and scheduled unattended runs never call Mem0");
    assert.equal(model.jobs.length, 0);
    assert.equal(readFileSync(briefing, "utf8"), "LEGACY-BRIEFING-UNCHANGED\n");
    for (const path of [...allFiles(f.jobs), ...allFiles(init.agentHome)]) {
      const content = readFileSync(path, "utf8");
      for (const secret of [init.secret, token, remoteSecret]) assert(!content.includes(secret), path);
    }
    for (const secret of [init.secret, token, remoteSecret]) assert(!(chat.output + serve.stderr + model.requests.join("")).includes(secret));
  } finally { init.close(); }
});
