import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "dist/src/cli.js");

function run(cwd: string, home: string, args: string[]) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      FEISHU_AGENT_INSPECT: "1",
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
    },
  });
}

test("inspect exposes isolated project, session, prompt, and resource state", () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-agent-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const launch = join(project, "nested");
  mkdirSync(join(home, ".feishu-agent"), { recursive: true });
  mkdirSync(join(home, ".pi", "agent", "skills", "pi-only"), { recursive: true });
  mkdirSync(join(project, ".agents", "skills", "agents-only"), { recursive: true });
  mkdirSync(join(project, ".pi", "skills", "project-pi-only"), { recursive: true });
  mkdirSync(join(project, ".feishu-agent"), { recursive: true });
  mkdirSync(launch, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: project });

  writeFileSync(join(home, ".feishu-agent", "SYSTEM.md"), "FEISHU SYSTEM IDENTITY\n");
  writeFileSync(join(home, ".pi", "agent", "AGENTS.md"), "PI GLOBAL MUST NOT LOAD\n");
  writeFileSync(join(project, "AGENTS.md"), "ROOT PROJECT CONTEXT\n");
  writeFileSync(join(project, ".feishu-agent", "AGENTS.md"), "FEISHU PROJECT CONTEXT\n");
  writeFileSync(join(project, ".pi", "SYSTEM.md"), "PROJECT PI SYSTEM MUST NOT LOAD\n");
  writeFileSync(join(home, ".pi", "agent", "skills", "pi-only", "SKILL.md"), "---\nname: pi-only\ndescription: no\n---\n");
  writeFileSync(join(project, ".agents", "skills", "agents-only", "SKILL.md"), "---\nname: agents-only\ndescription: no\n---\n");
  writeFileSync(join(project, ".pi", "skills", "project-pi-only", "SKILL.md"), "---\nname: project-pi-only\ndescription: no\n---\n");

  const state = JSON.parse(run(launch, home, ["-p", "ignored"])) as {
    launchCwd: string;
    projectRoot: string;
    agentHome: string;
    sessionDir: string;
    systemPrompt: string;
    contextFiles: string[];
    skills: string[];
    tools: string[];
  };

  assert.equal(state.launchCwd, realpathSync(launch));
  assert.equal(state.projectRoot, realpathSync(project));
  assert.equal(state.agentHome, join(realpathSync(home), ".feishu-agent"));
  assert.match(state.sessionDir, new RegExp(`^${join(realpathSync(home), ".feishu-agent", "sessions").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`));
  assert.match(state.systemPrompt, /FEISHU SYSTEM IDENTITY/);
  assert.match(state.systemPrompt, /ROOT PROJECT CONTEXT/);
  assert.match(state.systemPrompt, /FEISHU PROJECT CONTEXT/);
  assert.doesNotMatch(state.systemPrompt, /PI GLOBAL MUST NOT LOAD/);
  assert.doesNotMatch(state.systemPrompt, /PROJECT PI SYSTEM MUST NOT LOAD/);
  assert.deepEqual(state.contextFiles, [
    join(realpathSync(project), ".feishu-agent", "AGENTS.md"),
    join(realpathSync(project), "AGENTS.md"),
  ]);
  assert.deepEqual(state.skills, []);
  assert.deepEqual(state.tools, ["read", "edit", "write", "bash", "grep", "find", "ls"]);
});

test("non-git launch directory becomes the project", () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-agent-"));
  const home = join(root, "home");
  const launch = join(root, "plain");
  mkdirSync(join(home, ".feishu-agent"), { recursive: true });
  mkdirSync(launch, { recursive: true });
  writeFileSync(join(home, ".feishu-agent", "SYSTEM.md"), "FEISHU SYSTEM IDENTITY\n");

  const state = JSON.parse(run(launch, home, ["-p", "ignored"])) as {
    launchCwd: string;
    projectRoot: string;
  };

  assert.equal(state.projectRoot, state.launchCwd);
});
