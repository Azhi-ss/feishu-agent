#!/usr/bin/env node
process.env.MEM0_TELEMETRY = "false";

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runInteractive, runPrint } from "./runtime.js";
import { syncOfficialSkills } from "./official-skills.js";
import { packageManager } from "./packages.js";
import { initializeHome } from "./init.js";
import { checkReadiness } from "./readiness.js";
import { CORE_TOOLS, projectKeyFor } from "./policy.js";

function projectRoot(cwd: string): string {
  try {
    return realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    return realpathSync(cwd);
  }
}

function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function inspect(): void {
  const launchCwd = realpathSync(process.cwd());
  const root = projectRoot(launchCwd);
  const agentHome = join(realpathSync(homedir()), ".feishu-agent");
  const contextFiles = [join(root, ".feishu-agent", "AGENTS.md"), join(root, "AGENTS.md")].filter(existsSync);
  const systemPrompt = [readIfPresent(join(agentHome, "SYSTEM.md")), ...contextFiles.map(readIfPresent)].filter(Boolean).join("\n");
  process.stdout.write(JSON.stringify({
    launchCwd,
    projectRoot: root,
    agentHome,
    sessionDir: join(agentHome, "sessions", projectKeyFor(root)),
    systemPrompt,
    contextFiles,
    skills: [],
    tools: CORE_TOOLS,
    mem0Telemetry: process.env.MEM0_TELEMETRY,
    home: process.env.HOME,
    environmentMarker: process.env.FEISHU_TEST_MARKER,
    larkProfile: process.env.LARK_PROFILE,
  }));
}

const HELP = `Usage:
  feishu                         Start Interactive Feishu Runtime
  feishu -p <prompt>             Run one Print-mode turn
  feishu init [--identity ID] [--model provider/model]
                 [--reset-identity] [--reset-model] [--reset-system]
                                  Initialize/reset explicit Feishu choices
  feishu install <source> [-l]   Install a Feishu Package
  feishu remove <source> [-l]    Remove a Feishu Package
  feishu list                    List Feishu Packages
  feishu update [source|--extensions]
  feishu config [-l]
  feishu skills sync
  feishu -c                      Continue this Feishu Project's latest session
  feishu -r                      Select a session in this Feishu Project
  feishu --lark-profile <name>   Use a profile for this invocation only

Resource Isolation is not an OS sandbox. Installed Feishu Package extensions run with current-user permissions.
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function validateArgs(args: string[]): void {
  if (args.includes("--mode")) fail("JSON and RPC modes are not supported by Feishu Agent.");
  if (args.some((arg) => ["--json", "--rpc"].includes(arg))) fail("That mode is not supported by Feishu Agent.");
  if (args[0] === "-p" && !args[1]) fail("Print mode requires a prompt.");
  const allowed = new Set(["-p", "init", "install", "remove", "list", "update", "config", "skills", "-c", "-r", "--lark-profile"]);
  if (args[0] && !args[0].startsWith("-") && !allowed.has(args[0])) fail(`Unknown command: ${args[0]}`);
}

const args = process.argv.slice(2);
const profileIndex = args.indexOf("--lark-profile");
if (profileIndex >= 0) {
  if (!args[profileIndex + 1]) fail("--lark-profile requires a profile name.");
  process.env.LARK_PROFILE = args[profileIndex + 1];
  args.splice(profileIndex, 2);
}
if (args.includes("--help") || args.includes("-h")) process.stdout.write(HELP);
else {
  validateArgs(args);
  if (process.env.FEISHU_AGENT_INSPECT === "1") inspect();
  else if (args[0] === "init") {
    const identityIndex = args.indexOf("--identity");
    const identity = identityIndex >= 0 ? args[identityIndex + 1] : process.env.FEISHU_MEMORY_IDENTITY;
    if (!identity) fail("feishu init requires --identity <stable-id> (or FEISHU_MEMORY_IDENTITY for unattended initialization).");
    const agentHome = join(realpathSync(homedir()), ".feishu-agent");
    const result = initializeHome(agentHome, identity, { identity: args.includes("--reset-identity"), system: args.includes("--reset-system") });
    const modelIndex = args.indexOf("--model");
    const readiness = await checkReadiness(realpathSync(homedir()), agentHome, modelIndex >= 0 ? args[modelIndex + 1] : undefined, { resetModel: args.includes("--reset-model") });
    const root = projectRoot(realpathSync(process.cwd()));
    const manager = packageManager(agentHome, root, projectKeyFor(root));
    if (!manager.listConfiguredPackages().some((entry) => entry.scope === "user" && entry.source.includes("@mem0/pi-agent-plugin"))) {
      await manager.installAndPersist("npm:@mem0/pi-agent-plugin@0.1.5");
    }
    const skills = syncOfficialSkills(join(agentHome, "official-skills"));
    process.stdout.write(`Feishu Agent Home: ${agentHome}\nMemory Identity: ${result.identity}\nModel: ${readiness.model}\nMem0 Package: ready\nOfficial Skills: ${skills.version}\nLark doctor: ${readiness.doctor}\n`);
  }
  else if (args[0] === "skills" && args[1] === "sync") {
    const agentHome = join(realpathSync(homedir()), ".feishu-agent");
    try {
      const result = syncOfficialSkills(join(agentHome, "official-skills"), true);
      process.stdout.write(`Synchronized official Skills for ${result.version}.\n`);
    } catch (error) {
      fail(`Official Skill synchronization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  else if (args[0] === "config") {
    const cwd = realpathSync(process.cwd());
    const root = projectRoot(cwd);
    const agentHome = join(realpathSync(homedir()), ".feishu-agent");
    const compatCwd = join(agentHome, ".compat", "projects", projectKeyFor(root));
    packageManager(agentHome, root, projectKeyFor(root));
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      process.chdir(compatCwd);
      process.env.PI_CODING_AGENT_DIR = agentHome;
      const { main } = await import("@earendil-works/pi-coding-agent");
      await main(["config", "--approve"]);
    } finally {
      process.chdir(previousCwd);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
  else if (["install", "remove", "list", "update"].includes(args[0] ?? "")) {
    const cwd = realpathSync(process.cwd());
    const root = projectRoot(cwd);
    const agentHome = join(realpathSync(homedir()), ".feishu-agent");
    const manager = packageManager(agentHome, root, projectKeyFor(root));
    const local = args.includes("-l");
    const source = args.slice(1).find((arg) => !arg.startsWith("-"));
    try {
      if (args[0] === "install" && source) await manager.installAndPersist(source, { local });
      else if (args[0] === "remove" && source) {
        if (!await manager.removeAndPersist(source, { local })) fail(`No matching Feishu Package: ${source}`);
      } else if (args[0] === "update") await manager.update(args.includes("--extensions") ? undefined : source);
      else if (args[0] === "list") for (const entry of manager.listConfiguredPackages()) process.stdout.write(`${entry.scope}\t${entry.source}\n`);
      else fail(`${args[0]} requires a package source.`);
    } catch (error) { fail(`Feishu Package command failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  else if (args[0] === "-p") {
    const cwd = realpathSync(process.cwd());
    const root = projectRoot(cwd);
    const agentHome = join(realpathSync(homedir()), ".feishu-agent");
    runPrint(args[1], cwd, root, projectKeyFor(root), agentHome)
      .then((code) => { process.exitCode = code; })
      .catch((error: unknown) => {
        process.stderr.write(`Feishu Agent: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
  }
  else if (args.length === 0 || args[0] === "-c" || args[0] === "-r") {
    const cwd = realpathSync(process.cwd());
    const root = projectRoot(cwd);
    const agentHome = join(realpathSync(homedir()), ".feishu-agent");
    runInteractive(cwd, root, projectKeyFor(root), agentHome, args[0] === "-c", args[0] === "-r")
      .catch((error: unknown) => { process.stderr.write(`Feishu Agent: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
  } else {
    process.stderr.write("Feishu Agent runtime is not initialized. Run `feishu init`.\n");
    process.exitCode = 1;
  }
}
