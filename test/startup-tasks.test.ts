import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";
import { FeishuResourceLoader } from "../src/resources.js";
import { startupBannerExtension } from "../src/startup-banner.js";
import { beginStartupTaskPull, onTasksChanged, taskBannerRows, tasksExtension } from "../src/tasks.js";
import { fakeExtensionApi, startTuiSession } from "./helpers/extension-fixture.js";
import { waitFor } from "./helpers/automation-cli-fixture.js";
import { runPty } from "./helpers/pty-harness.js";

const cli = join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "dist/src/cli.js");

function localNoon(offsetDays: number): number {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return date.getTime();
}

function shortDate(offsetDays: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return date.getFullYear() === new Date().getFullYear() ? `${month}/${day}` : `${date.getFullYear()}/${month}/${day}`;
}

function frame(dir: string): string {
  const { api, handlers } = fakeExtensionApi();
  startupBannerExtension(dir, () => ({ context: ["AGENTS.md"], skills: ["skill-a"], prompts: [], extensions: [], themes: [] }))(api);
  return startTuiSession(handlers, { model: "m", reasons: ["startup", "reload", "new"] }).render(100);
}

describe("unfinished Feishu tasks", { concurrency: false }, () => {
test("banner rows rank by a pinned day instead of the wall clock", () => {
  // New year's day 2026: the previous year's tasks are overdue, the short date keeps its year.
  const now = new Date(2026, 0, 1, 9, 0, 0).getTime();
  const rows = taskBannerRows([
    { name: "Future", due: new Date(2026, 0, 3, 12).getTime() },
    { name: "Overdue", due: new Date(2025, 11, 30, 12).getTime() },
    { name: "Today", due: new Date(2026, 0, 1, 23).getTime() },
    { name: "Undated" },
  ], now);
  assert.deepEqual(rows, ["Overdue 2025/12/30", "Today 1/1", "Future 1/3", "Undated"]);
});

test("banner lists unfinished task names with short dates, overdue first, and +N past five", () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-tasks-banner-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ feishuStartup: { sections: ["tasks"] } }));
  writeFileSync(join(dir, "tasks.json"), JSON.stringify({
    tasks: [
      { name: "Echo", description: "DO NOT SHOW", assignee: "ou_owner", reminders: ["soon"] },
      { name: "Delta", due: localNoon(1) },
      { name: "Charlie", due: localNoon(0) },
      { name: "Bravo", due: localNoon(-1) },
      { name: "Alpha", due: localNoon(-2) },
      { name: "Hidden later" },
    ],
  }));
  const shown = frame(dir);
  let position = -1;
  for (const token of ["Alpha", "Bravo", "Charlie", "Delta", "+2"]) {
    const next = shown.indexOf(token, position + 1);
    assert.ok(next > position, `${token} out of order in:\n${shown}`);
    position = next;
  }
  assert.match(shown, new RegExp(`Alpha ${shortDate(-2)}`));
  assert.match(shown, new RegExp(`Bravo ${shortDate(-1)}`));
  assert.match(shown, new RegExp(`Charlie ${shortDate(0)}`));
  assert.match(shown, new RegExp(`Delta ${shortDate(1)}`));
  assert.doesNotMatch(shown, /Echo|Hidden later|DO NOT SHOW|ou_owner|soon/);
  assert.match(shown, /Tasks/);
});

test("Tasks stays hidden unless the section is selected and the local list has names", () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-tasks-hidden-"));
  const tasks = { tasks: [{ name: "Alpha", due: localNoon(0) }] };
  writeFileSync(join(dir, "tasks.json"), JSON.stringify(tasks));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ feishuStartup: { sections: ["skills"] } }));
  const withoutSection = frame(dir);
  assert.match(withoutSection, /Feishu Agent/);
  assert.match(withoutSection, /skill-a/);
  assert.doesNotMatch(withoutSection, /Tasks|Alpha/);

  writeFileSync(join(dir, "settings.json"), JSON.stringify({ feishuStartup: { banner: true } }));
  assert.doesNotMatch(frame(dir), /Tasks|Alpha/);

  writeFileSync(join(dir, "settings.json"), JSON.stringify({ theme: "dark" }));
  assert.match(frame(dir), /Feishu Agent/);
  assert.doesNotMatch(frame(dir), /Tasks|Alpha/);

  writeFileSync(join(dir, "settings.json"), JSON.stringify({ feishuStartup: { sections: ["tasks"] } }));
  writeFileSync(join(dir, "tasks.json"), "{not json");
  const corrupt = frame(dir);
  assert.match(corrupt, /Feishu Agent/);
  assert.doesNotMatch(corrupt, /Tasks/);

  writeFileSync(join(dir, "tasks.json"), JSON.stringify({ tasks: [] }));
  assert.doesNotMatch(frame(dir), /Tasks/);
});

test("an all-day due date is the UTC calendar day", () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-tasks-all-day-"));
  const previousTz = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ feishuStartup: { sections: ["tasks"] } }));
    writeFileSync(join(dir, "tasks.json"), JSON.stringify({
      tasks: [{ name: "New year", due: Date.UTC(2020, 0, 2), allDay: true }],
    }));
    const shown = frame(dir);
    assert.match(shown, /New year 2020\/1\/2/);
    assert.doesNotMatch(shown, /2020\/1\/1/);
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});

const LARK = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FEISHU_LARK_LOG, args.join(" ") + "\\n");
if (args[0] === "--version") { console.log("lark-cli 1.0.0"); process.exit(0); }
if (process.env.FEISHU_TASK_FAIL === "1") process.exit(1);
if (args[1] === "+get-my-tasks") { process.stdout.write(process.env.FEISHU_TASK_JSON ?? ""); process.exit(0); }
process.exit(2);
`;

function commandHome() {
  const root = mkdtempSync(join(tmpdir(), "feishu-tasks-cli-"));
  const home = join(root, "home");
  const agent = join(home, ".feishu-agent");
  const bin = join(root, "bin");
  const log = join(root, "lark.log");
  mkdirSync(agent, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(bin, "lark-cli"), LARK, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}`, FEISHU_LARK_LOG: log };
  return { home, agent, log, env };
}

function run(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env });
}

test("tasks refresh stores unfinished task names for the user and drops everything else", () => {
  const fixture = commandHome();
  fixture.env.FEISHU_TASK_JSON = JSON.stringify({
    ok: true,
    identity: "user",
    data: { items: [
      { summary: "Ship", due: { timestamp: "1791849600000", is_all_day: true }, description: "DO NOT STORE", members: [{ id: "ou_secret" }], reminders: ["ping"] },
      { summary: "  Loose note  ", completed_at: "0" },
      { summary: "Already done", completed_at: "1700000000000" },
      { summary: "   " },
    ] },
  });
  const result = run(["tasks", "refresh"], fixture.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Refreshed 2 unfinished Feishu tasks\./);
  assert.doesNotMatch(result.stdout + result.stderr, /DO NOT STORE|ou_secret|Already done|Loose note/);
  assert.equal(readFileSync(fixture.log, "utf8").trim(), "task +get-my-tasks --complete=false --as user --page-all");
  assert.deepEqual(JSON.parse(readFileSync(join(fixture.agent, "tasks.json"), "utf8")), {
    tasks: [
      { name: "Ship", due: 1791849600000, allDay: true },
      { name: "Loose note" },
    ],
  });
  fixture.env.FEISHU_TASK_JSON = JSON.stringify({ ok: true, identity: "user", data: { items: [] } });
  const cleared = run(["tasks", "refresh"], fixture.env);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.match(cleared.stdout, /Refreshed 0 unfinished Feishu tasks\./);
  assert.deepEqual(JSON.parse(readFileSync(join(fixture.agent, "tasks.json"), "utf8")), { tasks: [] });
});

test("a failed tasks refresh keeps the previous list and says what to do", () => {
  const fixture = commandHome();
  const file = join(fixture.agent, "tasks.json");
  const previous = '{"tasks":[{"name":"Keep me"}]}\n';
  writeFileSync(file, previous);
  fixture.env.FEISHU_TASK_FAIL = "1";
  const failed = run(["tasks", "refresh"], fixture.env);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /previous list was kept/);
  assert.match(failed.stderr, /lark-cli auth login/);
  // The shell entry names the shell's next step.
  assert.match(failed.stderr, /Then run `feishu tasks refresh`\./);
  assert.equal(readFileSync(file, "utf8"), previous);

  delete fixture.env.FEISHU_TASK_FAIL;
  fixture.env.FEISHU_TASK_JSON = "not-json";
  const unrecognized = run(["tasks", "refresh"], fixture.env);
  assert.notEqual(unrecognized.status, 0);
  assert.match(unrecognized.stderr, /previous list was kept/);
  assert.equal(readFileSync(file, "utf8"), previous);
});

test("tasks refresh reports a missing lark-cli without creating a list", () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-tasks-nolark-"));
  const home = join(root, "home");
  const agent = join(home, ".feishu-agent");
  const bin = join(root, "bin");
  mkdirSync(agent, { recursive: true });
  mkdirSync(bin);
  const result = run(["tasks", "refresh"], { ...process.env, HOME: home, PATH: bin });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /lark-cli was not found/);
  assert.match(result.stderr, /previous list was kept/);
  assert.equal(existsSync(join(agent, "tasks.json")), false);
});

test("reloading resources does not pull Feishu tasks", async () => {
  const fixture = commandHome();
  writeFileSync(join(fixture.agent, "settings.json"), JSON.stringify({ feishuStartup: { sections: ["tasks"] } }));
  writeFileSync(join(fixture.agent, "tasks.json"), JSON.stringify({ tasks: [{ name: "Keep me" }] }));
  const project = join(fixture.home, "project");
  mkdirSync(project);
  const previousPath = process.env.PATH;
  const previousLog = process.env.FEISHU_LARK_LOG;
  process.env.PATH = fixture.env.PATH;
  process.env.FEISHU_LARK_LOG = fixture.log;
  try {
    const loader = new FeishuResourceLoader(fixture.agent, project);
    await loader.reload();
    await loader.reload();
    const shown = frame(fixture.agent);
    assert.match(shown, /Keep me/);
    assert.doesNotMatch(readFileSync(fixture.log, "utf8"), /\btask\b/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.FEISHU_LARK_LOG;
    else process.env.FEISHU_LARK_LOG = previousLog;
  }
});

test("/tasks pulls unfinished tasks once and the next banner paint shows them", async () => {
  const fixture = commandHome();
  writeFileSync(join(fixture.agent, "settings.json"), JSON.stringify({ feishuStartup: { sections: ["tasks"] } }));
  fixture.env.FEISHU_TASK_JSON = JSON.stringify({ ok: true, identity: "user", data: { items: [{ summary: "Live task", completed_at: "0" }] } });
  const previousPath = process.env.PATH;
  const previousLog = process.env.FEISHU_LARK_LOG;
  const previousJson = process.env.FEISHU_TASK_JSON;
  process.env.PATH = fixture.env.PATH;
  process.env.FEISHU_LARK_LOG = fixture.log;
  process.env.FEISHU_TASK_JSON = fixture.env.FEISHU_TASK_JSON;
  const banner = fakeExtensionApi();
  const tasks = fakeExtensionApi();
  const notices: string[] = [];
  try {
    startupBannerExtension(fixture.agent)(banner.api);
    const session = startTuiSession(banner.handlers);
    tasksExtension(fixture.agent)(tasks.api);
    assert.doesNotMatch(session.render(80), /Live task/);
    assert.equal(existsSync(fixture.log), false);
    const command = tasks.commands.get("tasks");
    assert.ok(command);
    await command.handler("", { hasUI: true, ui: { notify: (message: string) => notices.push(message) } } as never);
    assert.match(session.render(80), /Live task/);
    assert.match(notices.join("\n"), /Pulled 1 unfinished Feishu task\./);
    assert.match(readFileSync(fixture.log, "utf8"), /task \+get-my-tasks --complete=false --as user/);
    assert.equal(session.paints(), 1);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.FEISHU_LARK_LOG;
    else process.env.FEISHU_LARK_LOG = previousLog;
    if (previousJson === undefined) delete process.env.FEISHU_TASK_JSON;
    else process.env.FEISHU_TASK_JSON = previousJson;
  }
});

test("startup does not pull tasks unless the banner section is enabled", () => {
  const fixture = commandHome();
  writeFileSync(join(fixture.agent, "settings.json"), JSON.stringify({ feishuStartup: { sections: ["skills"] } }));
  writeFileSync(join(fixture.agent, "tasks.json"), '{"tasks":[{"name":"Keep me"}]}\n');
  const previousPath = process.env.PATH;
  const previousLog = process.env.FEISHU_LARK_LOG;
  process.env.PATH = fixture.env.PATH;
  process.env.FEISHU_LARK_LOG = fixture.log;
  try {
    beginStartupTaskPull(fixture.agent);
    assert.equal(existsSync(fixture.log), false);
    assert.equal(readFileSync(join(fixture.agent, "tasks.json"), "utf8"), '{"tasks":[{"name":"Keep me"}]}\n');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.FEISHU_LARK_LOG;
    else process.env.FEISHU_LARK_LOG = previousLog;
  }
});

test("the banner repaints when an interactive startup pull lands", async () => {
  const fixture = commandHome();
  writeFileSync(join(fixture.agent, "settings.json"), JSON.stringify({ feishuStartup: { sections: ["tasks"] } }));
  writeFileSync(join(fixture.agent, "tasks.json"), JSON.stringify({ tasks: [{ name: "Stale task" }] }));
  fixture.env.FEISHU_TASK_JSON = JSON.stringify({ ok: true, identity: "user", data: { items: [{ summary: "Live task", completed_at: "0" }] } });
  const previousPath = process.env.PATH;
  const previousLog = process.env.FEISHU_LARK_LOG;
  const previousJson = process.env.FEISHU_TASK_JSON;
  process.env.PATH = fixture.env.PATH;
  process.env.FEISHU_LARK_LOG = fixture.log;
  process.env.FEISHU_TASK_JSON = fixture.env.FEISHU_TASK_JSON;
  const { api, handlers } = fakeExtensionApi();
  try {
    startupBannerExtension(fixture.agent)(api);
    const session = startTuiSession(handlers);
    assert.match(session.render(80), /Stale task/);
    assert.equal(session.paints(), 0);

    const landed = new Promise<void>((resolve) => { onTasksChanged(() => { resolve(); }); });
    beginStartupTaskPull(fixture.agent);
    await landed;

    assert.equal(session.paints(), 1, "the startup pull must repaint the banner exactly once");
    assert.match(session.render(80), /Live task/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.FEISHU_LARK_LOG;
    else process.env.FEISHU_LARK_LOG = previousLog;
    if (previousJson === undefined) delete process.env.FEISHU_TASK_JSON;
    else process.env.FEISHU_TASK_JSON = previousJson;
  }
});

test("a startup pull is once per Agent Home, not once per process", async () => {
  const fixture = commandHome();
  const other = join(fixture.home, "second-agent");
  mkdirSync(other);
  for (const home of [fixture.agent, other]) {
    writeFileSync(join(home, "settings.json"), JSON.stringify({ feishuStartup: { sections: ["tasks"] } }));
  }
  fixture.env.FEISHU_TASK_JSON = JSON.stringify({ ok: true, identity: "user", data: { items: [{ summary: "Live task", completed_at: "0" }] } });
  const previousPath = process.env.PATH;
  const previousLog = process.env.FEISHU_LARK_LOG;
  const previousJson = process.env.FEISHU_TASK_JSON;
  process.env.PATH = fixture.env.PATH;
  process.env.FEISHU_LARK_LOG = fixture.log;
  process.env.FEISHU_TASK_JSON = fixture.env.FEISHU_TASK_JSON;
  const pulled = () => existsSync(fixture.log) && readFileSync(fixture.log, "utf8").split("\n").filter((line) => line.includes("+get-my-tasks")).length;
  try {
    beginStartupTaskPull(fixture.agent);
    beginStartupTaskPull(other);
    beginStartupTaskPull(other);
    await waitFor(() => existsSync(join(fixture.agent, "tasks.json")) && existsSync(join(other, "tasks.json")));
    assert.equal(pulled(), 2, "one pull per Agent Home, and the repeat call adds nothing");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.FEISHU_LARK_LOG;
    else process.env.FEISHU_LARK_LOG = previousLog;
    if (previousJson === undefined) delete process.env.FEISHU_TASK_JSON;
    else process.env.FEISHU_TASK_JSON = previousJson;
  }
});

test("/tasks reports a failed pull and keeps the previous list", async () => {
  const fixture = commandHome();
  const file = join(fixture.agent, "tasks.json");
  const previous = '{"tasks":[{"name":"Keep me"}]}\n';
  writeFileSync(file, previous);
  const previousPath = process.env.PATH;
  const previousLog = process.env.FEISHU_LARK_LOG;
  const previousFail = process.env.FEISHU_TASK_FAIL;
  process.env.PATH = fixture.env.PATH;
  process.env.FEISHU_LARK_LOG = fixture.log;
  process.env.FEISHU_TASK_FAIL = "1";
  const tasks = fakeExtensionApi();
  const notices: Array<[string, string]> = [];
  try {
    tasksExtension(fixture.agent)(tasks.api);
    const command = tasks.commands.get("tasks");
    assert.ok(command);
    await command.handler("", { hasUI: true, ui: { notify: (message: string, level: string) => { notices.push([message, level]); } } } as never);
    const text = notices.map(([message]) => message).join("\n");
    assert.deepEqual(notices.map(([, level]) => level), ["error"]);
    assert.match(text, /previous list was kept/);
    // The TUI is told the TUI's next step, not the shell's.
    assert.match(text, /Try \/tasks again\./);
    assert.doesNotMatch(text, /feishu tasks refresh/);
    assert.equal(readFileSync(file, "utf8"), previous);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.FEISHU_LARK_LOG;
    else process.env.FEISHU_LARK_LOG = previousLog;
    if (previousFail === undefined) delete process.env.FEISHU_TASK_FAIL;
    else process.env.FEISHU_TASK_FAIL = previousFail;
  }
});

// Fake model plus credentials for the interactive PTY runs below. Two callers, so
// the setup lives here once; each run still owns its own PTY script.
async function interactiveFixture(fixture: ReturnType<typeof commandHome>): Promise<{ project: string; stop: () => void }> {
  const project = join(fixture.home, "project");
  mkdirSync(join(fixture.home, ".pi", "agent"), { recursive: true });
  mkdirSync(project);
  writeFileSync(join(fixture.agent, "settings.json"), JSON.stringify({
    defaultProvider: "fake", defaultModel: "fake-model", quietStartup: true, collapseChangelog: true,
    feishuStartup: { sections: ["tasks"] },
  }));
  writeFileSync(join(fixture.agent, "SYSTEM.md"), "You are Feishu Agent.\n");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  writeFileSync(join(fixture.home, ".pi", "agent", "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "fake-key" } }));
  writeFileSync(join(fixture.home, ".pi", "agent", "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", models: [{ id: "fake-model", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 256 }] } } }));
  delete fixture.env.PI_CODING_AGENT_DIR;
  delete fixture.env.FEISHU_REMOTE;
  fixture.env.PI_OFFLINE = "1";
  fixture.env.TERM = "xterm-256color";
  fixture.env.COLUMNS = "113";
  fixture.env.LINES = "32";
  return { project, stop: () => { server.close(); } };
}

test("interactive startup replaces the saved task list before the banner is used", async () => {
  const fixture = commandHome();
  const interactive = await interactiveFixture(fixture);
  writeFileSync(join(fixture.agent, "tasks.json"), JSON.stringify({ tasks: [{ name: "Stale task" }] }));
  fixture.env.FEISHU_TASK_JSON = JSON.stringify({ ok: true, identity: "user", data: { items: [{ summary: "Live task", completed_at: "0" }] } });
  try {
    const result = await runPty(interactive.project, [], fixture.env, [
      { wait: "Live task", send: "/quit\r" },
    ], { cliPath: cli, timeoutSec: 40 });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Live task/);
    assert.doesNotMatch(result.output, /Stale task/);
    assert.match(readFileSync(fixture.log, "utf8"), /task \+get-my-tasks --complete=false --as user/);
  } finally {
    interactive.stop();
  }
});

test("a failed startup pull still opens the TUI with the previous list", async () => {
  const fixture = commandHome();
  const interactive = await interactiveFixture(fixture);
  const file = join(fixture.agent, "tasks.json");
  writeFileSync(file, JSON.stringify({ tasks: [{ name: "Stale task" }] }));
  fixture.env.FEISHU_TASK_FAIL = "1";
  try {
    const result = await runPty(interactive.project, [], fixture.env, [
      { wait: "Stale task", send: "/quit\r" },
    ], { cliPath: cli, timeoutSec: 40 });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Stale task/);
    assert.match(readFileSync(fixture.log, "utf8"), /task \+get-my-tasks --complete=false --as user/);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { tasks: [{ name: "Stale task" }] });
  } finally {
    interactive.stop();
  }
});
});
