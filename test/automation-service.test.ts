import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fixture as initFixture, run as initRun } from "./helpers/init-e2e-fixture.js";
import { hermeticEnv } from "./helpers/hermetic-env.js";
import { files, toolResponse } from "./helpers/automation-cli-fixture.js";
import { baseEnv, cli, fixture, gate, textResponse, waitFor, type Fixture } from "./helpers/automation-trigger-fixture.js";

// The service manager is the OS seam: it reads the installed artifact and
// launches its real argv, including env -i, rather than simulating a Trigger.
async function serviceFixture() {
  const f = await fixture();
  renameSync(f.home, `${f.home} with spaces`); f.home += " with spaces";
  renameSync(f.bin, `${f.bin} with spaces`); f.bin += " with spaces";
  f.jobs += " with spaces";
  const lark = join(f.bin, "lark-cli");
  writeFileSync(lark, readFileSync(lark, "utf8").replaceAll("local-default", "approved-profile"), { mode: 0o755 });
  const manager = process.platform === "darwin" ? "launchctl" : "systemctl";
  const state = join(f.root, "manager.json");
  const calls = join(f.root, "manager-calls.jsonl");
  const script = `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const path = require('node:path');
const state = ${JSON.stringify(state)}, calls = ${JSON.stringify(calls)};
const args = process.argv.slice(2); fs.appendFileSync(calls, JSON.stringify(args)+'\\n');
let saved = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state)) : {};
const cmd = args[0] === '--user' ? args[1] : args[0];
const requested = (args.find(x => /org[.]feishu-agent[.]automation-/.test(x)) || '').split('/').at(-1).replace(/[.](service|plist)$/, '');
const live = () => { if (saved.id !== requested) return false; try { process.kill(saved.pid, 0); return !!saved.pid; } catch { return false; } };
const failFile = ${JSON.stringify(join(f.root, "fail"))};
if (fs.existsSync(failFile) && fs.readFileSync(failFile, 'utf8').trim() === cmd) process.exit(1);
if (cmd === 'show-environment' || (cmd === 'print' && !args[1].includes('/org.'))) process.exit(0);
if (cmd === 'show') { console.log(live() ? saved.pid : 0); process.exit(0); }
if (cmd === 'print') { if (!live()) process.exit(113); console.log('pid = '+saved.pid); process.exit(0); }
if (cmd === 'daemon-reload' || cmd === 'enable' || cmd === 'disable') {
  if (!args.includes('--now')) process.exit(0);
}
if (cmd === 'disable' || cmd === 'bootout') {
  if (live()) process.kill(saved.pid, 'SIGTERM');
  fs.writeFileSync(state, JSON.stringify({})); process.exit(0);
}
if (cmd !== 'start' && cmd !== 'bootstrap') process.exit(0);
const artifact = cmd === 'bootstrap' ? args.at(-1) : path.join(process.env.HOME, '.config/systemd/user', args.at(-1));
const text = fs.readFileSync(artifact, 'utf8');
let argv;
if (cmd === 'bootstrap') {
 const array = text.match(/<key>ProgramArguments<\\/key>\\s*<array>([\\s\\S]*?)<\\/array>/)[1];
 argv = [...array.matchAll(/<string>([\\s\\S]*?)<\\/string>/g)].map(x => x[1].replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&'));
} else {
 const line = text.match(/^ExecStart=(.*)$/m)[1];
 argv = [...line.matchAll(/"((?:\\\\.|[^"\\\\])*)"/g)].map(x => JSON.parse('"'+x[1]+'"').replace(/%%/g,'%').replace(/\\$\\$/g,'$'));
}
const log = fs.openSync(${JSON.stringify(join(f.root, "service.log"))}, 'a');
if (fs.existsSync(failFile) && fs.readFileSync(failFile, 'utf8').trim() === 'no-owner') argv = [process.execPath, '-e', 'process.exit(1)'];
const child = cp.spawn(argv[0], argv.slice(1), { detached:true, stdio:['ignore',log,log], env:{...process.env, MEM0_API_KEY:'MANAGER-SECRET-43', FEISHU_REMOTE_APP_SECRET:'MANAGER-REMOTE-43'} });
fs.writeFileSync(state, JSON.stringify({pid:child.pid, id:requested})); child.unref();
`;
  writeFileSync(join(f.bin, manager), script, { mode: 0o755 });
  // Never fall through to the real manager, even on the other platform.
  writeFileSync(join(f.bin, manager === "launchctl" ? "systemctl" : "launchctl"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  return { ...f, calls, state };
}

function command(f: Fixture & { node?: string; entry?: string }, args: string[], input?: string, extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(f.node ?? process.execPath, [f.entry ?? cli, ...args], { cwd: f.root,
    env: baseEnv(f, { FEISHU_AUTOMATION_CLOCK_FILE: undefined, ...extra }), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => stdout += data);
  child.stderr.on("data", data => stderr += data);
  child.stdin.end(input);
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

async function run(f: Fixture, args: string[], input?: string, extra: NodeJS.ProcessEnv = {}) {
  return command(f, ["automation", ...args], input, extra).done;
}

async function add(f: Fixture, name: string, at = new Date(Date.now() - 60_000).toISOString().slice(0, 16) + "Z") {
  const result = await run(f, ["add", "--name", name, "--at", at, "--prompt-stdin", "--lark-profile", "approved-profile", "--yes"], `Service task ${name}.`);
  assert.equal(result.code, 0, result.stderr);
}

function serviceArtifacts(f: Fixture): string[] {
  const dir = process.platform === "darwin" ? join(f.home, "Library/LaunchAgents") : join(f.home, ".config/systemd/user");
  return existsSync(dir) ? readdirSync(dir).map(name => join(dir, name)) : [];
}

async function cleanup(f: Awaited<ReturnType<typeof serviceFixture>>) {
  rmSync(join(f.root, "fail"), { force: true });
  await run(f, ["stop"]);
  if (existsSync(f.state)) {
    const saved = JSON.parse(readFileSync(f.state, "utf8"));
    if (saved.pid) { try { process.kill(saved.pid, "SIGKILL"); } catch { /* fake manager child already exited; best-effort cleanup */ } }
  }
  f.model.server.closeAllConnections();
  await new Promise<void>(resolve => f.model.server.close(() => resolve()));
}

test("Interactive, Print and explicit init perform no implicit service work", { timeout: 45_000 }, async t => {
  const f = await initFixture(); t.after(() => f.close());
  const marker = join(f.root, "service-called");
  for (const name of ["launchctl", "systemctl"]) {
    writeFileSync(join(f.root, "bin", name), `#!/bin/sh\nprintf called >> '${marker}'\nexit 99\n`, { mode: 0o755 });
  }
  const env = hermeticEnv(f.env);
  const initialized = await initRun(f.project, env, ["init", "--identity", "service-test", "--model", "fake/fake-model"]);
  assert.equal(initialized.code, 0, initialized.stderr);
  const printed = await initRun(f.project, env, ["-p", "No service activity."]);
  assert.equal(printed.code, 0, printed.stderr);
  // Non-TTY interactive startup still loads the real Runtime then exits on EOF.
  const interactive = spawn(process.execPath, [cli], { cwd: f.project, env, stdio: ["pipe", "pipe", "pipe"] });
  interactive.stdout.resume(); interactive.stderr.resume(); interactive.stdin.end();
  t.after(() => { interactive.kill("SIGTERM"); });
  const ended = new Promise<void>(resolve => interactive.once("close", () => resolve()));
  const timer = setTimeout(() => interactive.kill("SIGTERM"), 2000);
  await ended; clearTimeout(timer);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(f.home, "feishu-jobs")), false);
});

test("setup failure rolls back a new installation and preserves an older stopped configuration", { timeout: 45_000 }, async t => {
  const f = await serviceFixture(); t.after(() => cleanup(f));
  const fail = join(f.root, "fail");
  writeFileSync(fail, process.platform === "darwin" ? "bootstrap" : "start");
  const failed = await run(f, ["start"]);
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /disabled|stopped/i);
  assert.deepEqual(serviceArtifacts(f), []);
  rmSync(fail);
  assert.equal((await run(f, ["start"])).code, 0);
  assert.equal((await run(f, ["stop"])).code, 0);
  const artifact = serviceArtifacts(f)[0];
  const previous = readFileSync(artifact, "utf8");
  writeFileSync(fail, process.platform === "darwin" ? "bootstrap" : "start");
  assert.notEqual((await run(f, ["start"])).code, 0);
  assert.equal(readFileSync(artifact, "utf8"), previous);
  const status = JSON.parse((await run(f, ["status"])).stdout);
  assert.equal(status.triggerRunning, false);
  assert.equal(status.serviceInstalled, true);
  assert.match(status.notice, /not guaranteed/i);
});

test("explicit start refreshes an owned installation and failed prerequisites keep the working service intact", { timeout: 35_000 }, async t => {
  const f = await serviceFixture(); t.after(() => cleanup(f));
  const first = await run(f, ["start"]); assert.equal(first.code, 0, first.stderr);
  const path = serviceArtifacts(f)[0];
  writeFileSync(path, readFileSync(path, "utf8") + (process.platform === "darwin" ? "<!-- prior installation -->\n" : "# prior installation\n"));
  const previous = readFileSync(path, "utf8");
  const missing = await run(f, ["start"], undefined, { PATH: f.bin.replace("bin with spaces", "missing") });
  assert.notEqual(missing.code, 0);
  assert.equal(readFileSync(path, "utf8"), previous);
  assert.equal(JSON.parse((await run(f, ["status"])).stdout).triggerPid, JSON.parse(first.stdout).triggerPid);
  const updated = await run(f, ["start"]); assert.equal(updated.code, 0, updated.stderr);
  assert.notEqual(JSON.parse(updated.stdout).triggerPid, JSON.parse(first.stdout).triggerPid);
  assert.doesNotMatch(readFileSync(path, "utf8"), /prior installation/);
});

test("unavailable user manager and missing executables leave no installation; foreground remains usable", { timeout: 30_000 }, async t => {
  const f = await serviceFixture(); t.after(() => cleanup(f));
  writeFileSync(join(f.root, "fail"), process.platform === "darwin" ? "print" : "show-environment");
  const failed = await run(f, ["start"]);
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /foreground fallback/);
  assert.deepEqual(serviceArtifacts(f), []);
  const foreground = command(f, ["automation", "serve"]);
  t.after(() => { foreground.child.kill("SIGTERM"); });
  await waitFor(() => existsSync(join(f.jobs, "trigger.lock")));
  const status = JSON.parse((await run(f, ["status"])).stdout);
  assert.equal(status.triggerRunning, true);
  assert.match(status.managerError, /failed/);
  foreground.child.kill("SIGTERM"); await foreground.done;
  rmSync(join(f.root, "fail"));
  rmSync(join(f.bin, "lark-cli"));
  const missing = await run(f, ["start"], undefined, { PATH: f.bin });
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /lark-cli.*unavailable/);
  assert.deepEqual(serviceArtifacts(f), []);
});

test("a new workspace beneath a symlinked parent retains the same service identity for status and stop", { timeout: 30_000 }, async t => {
  const f = await serviceFixture(); t.after(() => cleanup(f));
  const real = join(f.root, "real parent"); mkdirSync(real);
  const alias = join(f.root, "parent alias"); symlinkSync(real, alias, "dir");
  f.jobs = join(alias, "new workspace");
  const started = await run(f, ["start"]); assert.equal(started.code, 0, started.stderr);
  const status = JSON.parse((await run(f, ["status"])).stdout);
  assert.equal(status.serviceInstalled, true);
  assert.equal(status.owner, "service");
  assert.equal(status.triggerPid, JSON.parse(started.stdout).triggerPid);
  const stopped = await run(f, ["stop"]); assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).triggerRunning, false);
});

test("an installed artifact without a live Trigger is not reported as running", { timeout: 25_000 }, async t => {
  const f = await serviceFixture(); t.after(() => cleanup(f));
  const started = await run(f, ["start"]); assert.equal(started.code, 0, started.stderr);
  const pid = JSON.parse(started.stdout).triggerPid;
  // This PID is the fake manager's freshly launched child, not recovered state.
  process.kill(pid, "SIGTERM");
  await waitFor(() => !existsSync(join(f.jobs, "trigger.lock")));
  const status = JSON.parse((await run(f, ["status"])).stdout);
  assert.equal(status.serviceInstalled, true); assert.equal(status.triggerRunning, false);
  assert.match(status.notice, /not guaranteed/);
});

test("service stop bounds scheduled work but keeps independent manual runs alive and occupying capacity", { timeout: 45_000 }, async t => {
  const f = await serviceFixture(); t.after(() => cleanup(f));
  await add(f, "manual", "2035-01-01T00:00Z");
  await add(f, "scheduled");
  const manualGate = gate(textResponse("MANUAL-SURVIVED-43"), true);
  const scheduledGate = gate(textResponse("SHOULD-NOT-FINISH"), true);
  f.model.jobs.push(manualGate, scheduledGate);
  const manual = command(f, ["automation", "run", "manual"]);
  t.after(() => { manualGate.release(); scheduledGate.release(); manual.child.kill("SIGTERM"); });
  await waitFor(() => f.model.requests.length === 1);
  assert.equal((await run(f, ["start"])).code, 0);
  await waitFor(() => f.model.requests.length === 2);
  const begin = Date.now();
  const stopped = await run(f, ["stop"]);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert(Date.now() - begin < 25_000, "bounded stop");
  assert.equal(manual.child.exitCode, null);
  assert.equal(manual.child.signalCode, null);
  const scheduled = JSON.parse((await run(f, ["show", "scheduled"])).stdout);
  assert.equal(scheduled.latestRun.outcome, "unknown");
  assert.equal((await run(f, ["start"])).code, 0);
  const overlap = await run(f, ["run", "manual"]);
  assert.notEqual(overlap.code, 0); assert.match(overlap.stderr, /already running/i);
  manualGate.release();
  assert.equal((await manual.done).code, 0);
  assert.equal(JSON.parse((await run(f, ["show", "manual"])).stdout).latestRun.outcome, "completed");
  assert.equal(f.model.requests.length, 2, "no replay after unknown or restart");
});

test("resolved Node and package paths containing spaces work without shell initialization", { timeout: 30_000 }, async t => {
  const original = await serviceFixture(); t.after(() => cleanup(original));
  const layout = join(original.root, "alternate node and package"); mkdirSync(layout);
  const node = join(layout, "node"); copyFileSync(process.execPath, node);
  cpSync(dirname(cli), join(layout, "src"), { recursive: true });
  symlinkSync(join(dirname(cli), "../../node_modules"), join(layout, "node_modules"), "dir");
  const f = { ...original, node, entry: join(layout, "src/cli.js") };
  f.model.jobs.push(gate(textResponse("ALTERNATE-LAYOUT-43")));
  await add(f, "layout");
  const started = await run(f, ["start"]); assert.equal(started.code, 0, started.stderr);
  await waitFor(() => f.model.requests.length === 1);
  const artifact = readFileSync(serviceArtifacts(f)[0], "utf8");
  assert.match(artifact, /alternate node and package/);
  assert.equal((await run(f, ["stop"])).code, 0);
});

test("startup readiness failure and stop failure are honest, preserve jobs, and can be retried", { timeout: 40_000 }, async t => {
  const f = await serviceFixture(); t.after(() => cleanup(f));
  await add(f, "retained", "2035-01-01T00:00Z");
  // A manager can accept a launch while its child fails before owning the workspace.
  writeFileSync(join(f.root, "fail"), "no-owner");
  const failed = await run(f, ["start"]);
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /no live owned Trigger/);
  assert.deepEqual(serviceArtifacts(f), []);
  rmSync(join(f.root, "fail"));
  assert.equal((await run(f, ["start"])).code, 0);
  writeFileSync(join(f.root, "fail"), "disable");
  const stop = await run(f, ["stop"]); assert.notEqual(stop.code, 0);
  assert.match(stop.stderr, /disable failed/);
  assert.equal(JSON.parse((await run(f, ["status"])).stdout).triggerRunning, true);
  rmSync(join(f.root, "fail"));
  assert.equal((await run(f, ["stop"])).code, 0);
  assert.equal(JSON.parse((await run(f, ["show", "retained"])).stdout).state, "enabled");
});

test("service start refuses a live foreground owner and malformed or unattended commands never call the manager", { timeout: 30_000 }, async t => {
  const f = await serviceFixture(); t.after(() => cleanup(f));
  for (const verb of ["start", "stop", "status"]) {
    assert.notEqual((await run(f, [verb, "--yes"])).code, 0);
    assert.notEqual((await run(f, [verb], undefined, { FEISHU_UNATTENDED: "1" })).code, 0);
  }
  assert.equal(existsSync(f.calls), false);
  const foreground = command(f, ["automation", "serve"]);
  t.after(() => { foreground.child.kill("SIGTERM"); });
  await waitFor(() => existsSync(join(f.jobs, "trigger.lock")));
  const start = await run(f, ["start"]);
  assert.notEqual(start.code, 0); assert.match(start.stderr, /foreground Trigger already owns/);
  assert.deepEqual(serviceArtifacts(f), []);
  foreground.child.kill("SIGTERM"); await foreground.done;
});

test("explicit background start hosts the common Trigger, dispatches fresh Print, reports live ownership and stops without deleting history", { timeout: 45_000 }, async t => {
  const f = await serviceFixture();
  t.after(() => cleanup(f));
  f.model.jobs.push(gate(toolResponse("bash", { command: "printf 'PROFILE=%s\\n' \"$LARK_PROFILE\"; env" }, "env-43")), gate(textResponse("BACKGROUND-RESULT-43")));
  await add(f, "background");
  const started = await run(f, ["start"], undefined, { MEM0_API_KEY: "CALLER-SECRET-43", LARK_PROFILE: "different-default" });
  assert.equal(started.code, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).triggerRunning, true);
  assert.equal(JSON.parse(started.stdout).owner, "service");
  await waitFor(() => f.model.requests.length === 2);
  let shown;
  for (let i = 0; i < 100; i++) {
    const result = await run(f, ["show", "background"]);
    shown = JSON.parse(result.stdout);
    if (shown.latestRun?.endedAt) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(shown.latestRun.outcome, "completed");
  assert.equal(shown.profile, "approved-profile");
  const status = await run(f, ["status"]);
  assert.equal(JSON.parse(status.stdout).triggerRunning, true);
  const duplicate = await run(f, ["start"]);
  assert.equal(duplicate.code, 0, duplicate.stderr);
  assert.equal(JSON.parse(duplicate.stdout).triggerPid, JSON.parse(started.stdout).triggerPid);
  const foreground = await run(f, ["serve"]);
  assert.notEqual(foreground.code, 0);
  assert.match(foreground.stderr, /already running/i);
  const stopped = await run(f, ["stop"]);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).triggerRunning, false);
  const after = JSON.parse((await run(f, ["show", "background"])).stdout);
  assert.equal(after.latestRun.outcome, "completed");
  assert.equal(after.state, "enabled");
  assert.equal(f.model.requests.length, 2);
  const logs = files(f.jobs).filter(path => path.endsWith(".stdout.log"));
  assert(logs.some(path => readFileSync(path, "utf8").includes("BACKGROUND-RESULT-43")));
  assert.match(f.model.requests[1], /PROFILE=approved-profile/);
  assert.doesNotMatch(f.model.requests.join("\n"), /CALLER-SECRET-43|MANAGER-SECRET-43|MANAGER-REMOTE-43/);
  for (const result of [started, status, duplicate, foreground, stopped]) {
    assert.doesNotMatch(result.stdout + result.stderr, /CALLER-SECRET-43|MANAGER-SECRET-43|MANAGER-REMOTE-43/);
  }
  for (const path of files(f.home).concat(files(f.jobs))) {
    assert.doesNotMatch(readFileSync(path, "utf8"), /CALLER-SECRET-43|MANAGER-SECRET-43|MANAGER-REMOTE-43/, path);
  }
});
