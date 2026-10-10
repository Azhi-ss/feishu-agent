import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";
import { FeishuResourceLoader } from "../src/resources.js";
import { startupBannerExtension } from "../src/startup-banner.js";

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
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const handlers: Record<string, Array<(event: unknown, ctx: unknown) => void>> = {};
  let header: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
  try {
    startupBannerExtension(() => ({ context: ["AGENTS.md"], skills: ["skill-a"], prompts: [], extensions: [], themes: [] }))({
      on: (event: string, handler: (event: unknown, ctx: unknown) => void) => { (handlers[event] ??= []).push(handler); },
    } as never);
    for (const reason of ["startup", "reload", "new"]) {
      for (const handler of handlers.session_start ?? []) {
        handler({ reason }, { mode: "tui", model: { id: "m" }, ui: { setHeader: (next: typeof header) => { header = next; } } });
      }
    }
    assert.ok(header);
    return header(undefined, { fg: (_color: string, text: string) => text }).render(100).join("\n");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

describe("unfinished Feishu tasks", { concurrency: false }, () => {
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

test("startup, /new, and /reload read the local task list without calling lark-cli task", async () => {
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
});
