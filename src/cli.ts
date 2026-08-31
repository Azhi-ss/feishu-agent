#!/usr/bin/env node
process.env.MEM0_TELEMETRY = "false";

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const CORE_TOOLS = ["read", "edit", "write", "bash", "grep", "find", "ls"];

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

function projectKey(root: string): string {
  const slug = basename(root).replace(/[^a-zA-Z0-9._-]+/g, "-") || "project";
  return `${slug}-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
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
    sessionDir: join(agentHome, "sessions", projectKey(root)),
    systemPrompt,
    contextFiles,
    skills: [],
    tools: CORE_TOOLS,
    mem0Telemetry: process.env.MEM0_TELEMETRY,
    home: process.env.HOME,
    environmentMarker: process.env.FEISHU_TEST_MARKER,
  }));
}

const HELP = `Usage:
  feishu                         Start Interactive Feishu Runtime
  feishu -p <prompt>             Run one Print-mode turn
  feishu init                    Initialize Feishu Agent Home
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
if (args.includes("--help") || args.includes("-h")) process.stdout.write(HELP);
else {
  validateArgs(args);
  if (process.env.FEISHU_AGENT_INSPECT === "1") inspect();
  else {
    process.stderr.write("Feishu Agent runtime is not initialized. Run `feishu init`.\n");
    process.exitCode = 1;
  }
}
