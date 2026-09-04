import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { findSkillExtension, installSkillToFeishuHome, parseSkillSpec, searchSkills, skillSpec, type SkillsCliRunner } from "../src/find-skill.js";

test("find-skill validates source specs and normalizes search results from the skills.sh contract", async () => {
  assert.deepEqual(parseSkillSpec("owner/repo@technical-writing"), { source: "owner/repo", name: "technical-writing", spec: "owner/repo@technical-writing" });
  assert.throws(() => parseSkillSpec("owner/repo;rm -rf@skill"), /owner\/repo@skill-name/);
  assert.throws(() => parseSkillSpec("owner/repo@../skill"), /owner\/repo@skill-name/);

  const calls: URL[] = [];
  const fetcher = (async (input: URL | string) => {
    calls.push(new URL(String(input)));
    return new Response(JSON.stringify({ skills: [
      { id: "owner/repo/low", source: "owner/repo", name: "low", installs: 2 },
      { id: "other/tools/popular", source: "other/tools", name: "popular", installs: 1200 },
      { id: "bad/repo/not-valid", source: "bad/repo", name: "not_valid", installs: 9999 },
    ] }), { status: 200 });
  }) as typeof fetch;
  const results = await searchSkills("technical notes", fetcher);
  assert.equal(calls[0]?.pathname, "/api/search");
  assert.equal(calls[0]?.searchParams.get("q"), "technical notes");
  assert.equal(calls[0]?.searchParams.get("limit"), "20");
  assert.deepEqual(results.map((entry) => entry.name), ["popular", "low"]);
  assert.equal(skillSpec(results[0]!), "other/tools@popular");
});

test("private installation stages in an isolated HOME and copies references only into Feishu Agent Home", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-find-skill-test-"));
  const agentHome = join(root, ".feishu-agent");
  let stagedHome = "";
  let invocation: readonly string[] = [];
  const oldKey = process.env.MEM0_API_KEY;
  process.env.MEM0_API_KEY = "must-not-reach-installer";
  const runner: SkillsCliRunner = async (args, env) => {
    invocation = args;
    stagedHome = env.HOME!;
    assert.equal(env.MEM0_API_KEY, undefined);
    const skill = join(stagedHome, ".pi", "agent", "skills", "technical-writing");
    mkdirSync(join(skill, "references"), { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: technical-writing\ndescription: readable notes\nlicense: MIT\n---\nbody\n");
    writeFileSync(join(skill, "references", "style.md"), "reference");
  };

  let installed: string;
  try { installed = await installSkillToFeishuHome("owner/repo@technical-writing", agentHome, { runSkillsCli: runner }); }
  finally {
    if (oldKey === undefined) delete process.env.MEM0_API_KEY;
    else process.env.MEM0_API_KEY = oldKey;
  }
  assert.equal(installed, join(agentHome, "skills", "technical-writing"));
  assert.match(readFileSync(join(installed, "SKILL.md"), "utf8"), /readable notes/);
  assert.equal(readFileSync(join(installed, "references", "style.md"), "utf8"), "reference");
  assert.deepEqual([...invocation], ["--yes", "skills", "add", "owner/repo", "--skill", "technical-writing", "--global", "--agent", "pi", "--copy", "--yes"]);
  assert.equal(existsSync(join(root, ".agents")), false);
  assert.equal(existsSync(join(root, ".pi")), false);
  assert.equal(existsSync(stagedHome), false, "temporary installer HOME must be removed");
});

test("the default installer uses a real npx subprocess without touching the caller's HOME", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-find-skill-npx-"));
  const agentHome = join(root, ".feishu-agent");
  const bin = join(root, "bin");
  const trace = join(root, "npx.trace");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "npx"), `#!/bin/sh
printf '%s|%s|%s\\n' "$HOME" "$PWD" "$*" > ${JSON.stringify(trace)}
mkdir -p "$HOME/.pi/agent/skills/demo-skill/references"
printf '%s\\n' '---' 'name: demo-skill' 'description: demo' 'license: MIT' '---' 'body' > "$HOME/.pi/agent/skills/demo-skill/SKILL.md"
printf '%s' 'ref' > "$HOME/.pi/agent/skills/demo-skill/references/readme.md"
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${oldPath ?? ""}`;
  try {
    const installed = await installSkillToFeishuHome("owner/repo@demo-skill", agentHome);
    assert.equal(readFileSync(join(installed, "references", "readme.md"), "utf8"), "ref");
    const [usedHome, usedCwd, args] = readFileSync(trace, "utf8").trim().split("|");
    assert.notEqual(usedHome, process.env.HOME);
    assert.equal(usedCwd, usedHome);
    assert.match(args, /skills add owner\/repo .*--skill demo-skill/);
    assert.doesNotMatch(readFileSync(trace, "utf8"), /MEM0_API_KEY|must-not-reach-installer/);
  } finally { process.env.PATH = oldPath; }
});

test("private installation refuses malformed or unsafe source trees and preserves existing Skills", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-find-skill-safety-"));
  const agentHome = join(root, ".feishu-agent");
  const existing = join(agentHome, "skills", "technical-writing");
  mkdirSync(existing, { recursive: true });
  writeFileSync(join(existing, "SKILL.md"), "old");
  let invoked = false;
  const runner: SkillsCliRunner = async (_args, env) => {
    invoked = true;
    const skill = join(env.HOME!, ".pi", "agent", "skills", "technical-writing");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: technical-writing\ndescription: new\n---\n");
  };
  await assert.rejects(() => installSkillToFeishuHome("owner/repo@technical-writing", agentHome, { runSkillsCli: runner }), /already exists/);
  assert.equal(readFileSync(join(existing, "SKILL.md"), "utf8"), "old");
  assert.equal(invoked, true);
  await installSkillToFeishuHome("owner/repo@technical-writing", agentHome, { overwrite: true, runSkillsCli: runner });
  assert.equal(readFileSync(join(existing, "SKILL.md"), "utf8"), "---\nname: technical-writing\ndescription: new\n---\n");
  assert.throws(() => parseSkillSpec("owner/repo@bad--name"), /owner\/repo@skill-name/);

  const symlinkRunner: SkillsCliRunner = async (_args, env) => {
    const skill = join(env.HOME!, ".pi", "agent", "skills", "technical-writing");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: technical-writing\ndescription: unsafe\n---\n");
    writeFileSync(join(env.HOME!, "outside.txt"), "outside");
    symlinkSync(join(env.HOME!, "outside.txt"), join(skill, "linked.txt"));
  };
  const isolated = join(root, "isolated-agent");
  await assert.rejects(() => installSkillToFeishuHome("owner/repo@technical-writing", isolated, { runSkillsCli: symlinkRunner }), /symbolic links/);
  assert.equal(existsSync(join(isolated, "skills", "technical-writing")), false);
});

test("find-skill searches, confirms, installs, and reloads through its slash command", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-find-skill-command-"));
  const agentHome = join(root, ".feishu-agent");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "npx"), `#!/bin/sh
mkdir -p "$HOME/.pi/agent/skills/demo-skill"
printf '%s\\n' '---' 'name: demo-skill' 'description: demo' 'license: MIT' '---' 'body' > "$HOME/.pi/agent/skills/demo-skill/SKILL.md"
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  const oldApi = process.env.FEISHU_SKILLS_API_URL;
  const oldFetch = globalThis.fetch;
  process.env.PATH = `${bin}${delimiter}${oldPath ?? ""}`;
  globalThis.fetch = (async () => new Response(JSON.stringify({ skills: [{ id: "owner/repo/demo-skill", source: "owner/repo", name: "demo-skill", installs: 42 }] }), { status: 200 })) as typeof fetch;
  delete process.env.FEISHU_SKILLS_API_URL;
  try {
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    findSkillExtension(agentHome)({
      registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
    } as never);
    const command = commands.get("find-skill")!;
    let selected = "";
    let confirmations = 0;
    let reloaded = 0;
    const notifications: string[] = [];
    await command.handler("technical notes", {
      mode: "tui",
      hasUI: true,
      ui: {
        select: async (_title: string, options: string[]) => { selected = options[0]!; return selected; },
        confirm: async () => { confirmations++; return true; },
        notify: (message: string) => notifications.push(message),
      },
      reload: async () => { reloaded++; },
    });
    assert.match(selected, /owner\/repo@demo-skill/);
    assert.equal(confirmations, 1);
    assert.equal(reloaded, 1);
    assert.equal(readFileSync(join(agentHome, "skills", "demo-skill", "SKILL.md"), "utf8").includes("description: demo"), true);
    assert.match(notifications.join("\n"), /Installed demo-skill/);
  } finally {
    process.env.PATH = oldPath;
    if (oldApi === undefined) delete process.env.FEISHU_SKILLS_API_URL;
    else process.env.FEISHU_SKILLS_API_URL = oldApi;
    globalThis.fetch = oldFetch;
  }
});

test("find-skill is registered as a Feishu-owned slash command", () => {
  const commands = new Map<string, unknown>();
  findSkillExtension(join(tmpdir(), "feishu-agent"))({
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
  } as never);
  assert.equal(commands.has("find-skill"), true);
});
