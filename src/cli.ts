#!/usr/bin/env node
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
  }));
}

if (process.env.FEISHU_AGENT_INSPECT === "1") inspect();
else {
  process.stderr.write("Feishu Agent runtime is not initialized. Run `feishu init`.\n");
  process.exitCode = 1;
}
