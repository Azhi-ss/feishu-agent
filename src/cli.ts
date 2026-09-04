#!/usr/bin/env node
process.env.MEM0_TELEMETRY = "false";
process.env.PI_CODING_AGENT_DIR ??= join(homedir(), ".feishu-agent");

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runInteractive, runPrint } from "./runtime.js";
import { syncOfficialSkills } from "./official-skills.js";
import { packageManager } from "./packages.js";
import { dispatchConfig, setPackageResourceEnabled, type PackageResourceType } from "./config.js";
import { existingIdentity, initializeHome } from "./init.js";
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
    piCodingAgentDir: process.env.PI_CODING_AGENT_DIR,
  }));
}

const MEM0_PACKAGE = "npm:@mem0/pi-agent-plugin@0.1.5";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = typeof THINKING_LEVELS[number];

const HELP = `Usage:
  feishu                         Start Interactive Feishu Runtime
  feishu -p <prompt>             Run one Print-mode turn
  feishu init [--identity ID] [--model provider/model] [--thinking LEVEL]
                 [--reset-identity] [--reset-model] [--reset-system]
                                  Initialize/reset explicit Feishu choices
  feishu install <source> [-l]   Install a Feishu Package
  feishu remove <source> [-l]    Remove a Feishu Package
  feishu list                    List Feishu Packages
  feishu update [source|--extensions]
  feishu config [-l]
  feishu config [-l] set <source> <extensions|skills|prompts|themes> <on|off>
                                  Open or script Feishu Package resource settings
  feishu skills sync
  feishu -r                      Select a session in this Feishu Project
  feishu -c                      Continue this Feishu Project's latest session
  feishu --session <id>          Resume an exact session in this Feishu Project
  feishu --lark-profile <name>   Use a profile for this invocation only

Resource Isolation is not an OS sandbox. Installed Feishu Package extensions run with current-user permissions.
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function invalidOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-") || !value.trim()) fail(`${flag} requires a value.`);
  return value;
}

function normalizeAndValidateArgs(input: string[]): string[] {
  const args = [...input];
  const profiles = args.reduce<number[]>((found, arg, index) => arg === "--lark-profile" ? [...found, index] : found, []);
  if (profiles.length > 1) fail("--lark-profile may be specified only once.");
  if (profiles.length) {
    const index = profiles[0];
    process.env.LARK_PROFILE = invalidOptionValue(args, index, "--lark-profile");
    args.splice(index, 2);
  }
  if (args.includes("--mode") || args.some((arg) => ["--json", "--rpc"].includes(arg))) fail("That mode is not supported by Feishu Agent.");
  if (args.length === 0) return args;
  if (args.length === 1 && ["--help", "-h", "-c", "-r", "list"].includes(args[0])) return args;
  if (args[0] === "--session") {
    if (args.length !== 2 || !args[1] || args[1].startsWith("-")) fail("--session requires a session ID.");
    return args;
  }

  switch (args[0]) {
    case "-p":
      if (args.length !== 2 || !args[1] || args[1].startsWith("-")) fail("Print mode requires a prompt and accepts no extra arguments.");
      return args;
    case "init": {
      const valueFlags = new Set(["--identity", "--model", "--thinking"]);
      const resetFlags = new Set(["--reset-identity", "--reset-model", "--reset-system"]);
      const seen = new Set<string>();
      for (let index = 1; index < args.length; index++) {
        const flag = args[index];
        if (seen.has(flag)) fail(`${flag} may be specified only once.`);
        seen.add(flag);
        if (valueFlags.has(flag)) {
          const value = invalidOptionValue(args, index, flag);
          if (flag === "--thinking" && !THINKING_LEVELS.includes(value as ThinkingLevel)) fail(`--thinking must be one of ${THINKING_LEVELS.join(", ")}.`);
          if (flag === "--model" && !/^[^/\s]+\/[^/\s]+$/.test(value)) fail("--model must be provider/model.");
          index++;
        }
        else if (!resetFlags.has(flag)) fail(`Unknown feishu init option: ${flag}`);
      }
      return args;
    }
    case "install":
    case "remove": {
      const rest = args.slice(1);
      if (rest.filter((arg) => arg === "-l").length > 1 || rest.some((arg) => arg.startsWith("-") && arg !== "-l") || rest.filter((arg) => arg !== "-l").length !== 1) fail(`Usage: feishu ${args[0]} <source> [-l]`);
      return args;
    }
    case "update":
      if (args.length > 2 || (args[1]?.startsWith("-") && args[1] !== "--extensions")) fail("Usage: feishu update [source|--extensions]");
      return args;
    case "config": {
      const rest = args.slice(1);
      if (rest.length === 0 || (rest.length === 1 && rest[0] === "-l")) return args;
      const local = rest[0] === "-l";
      const set = rest.slice(local ? 1 : 0);
      if (set.length !== 4 || set[0] !== "set" || set.slice(1).some((value) => !value || value.startsWith("-"))) fail("Usage: feishu config [-l] set <source> <extensions|skills|prompts|themes> <on|off>");
      if (!["extensions", "skills", "prompts", "themes"].includes(set[2]) || !["on", "off"].includes(set[3])) fail("Usage: feishu config [-l] set <source> <extensions|skills|prompts|themes> <on|off>");
      return args;
    }
    case "skills":
      if (args.length !== 2 || args[1] !== "sync") fail("Usage: feishu skills sync");
      return args;
    default:
      if (args[0].startsWith("-")) fail(`Unsupported option: ${args[0]}`);
      fail(`Unknown command: ${args[0]}`);
  }
}

async function promptInitChoices(home: string, agentHome: string, identity: string | undefined, model: string | undefined, resetIdentity: boolean, resetModel: boolean): Promise<{ identity: string; model?: string }> {
  const savedIdentity = existingIdentity(agentHome);
  const settings = existsSync(join(agentHome, "settings.json")) ? JSON.parse(readFileSync(join(agentHome, "settings.json"), "utf8") || "{}") as { defaultProvider?: string; defaultModel?: string } : {};
  const savedModel = settings.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : undefined;
  if (!resetIdentity && savedIdentity) identity = savedIdentity;
  if (!resetModel && savedModel) model = savedModel;
  if (identity && model) return { identity, model };
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (!identity) fail("Fresh unattended feishu init requires --identity <stable-id> or FEISHU_MEMORY_IDENTITY.");
    if (!model) fail("Select an authenticated model explicitly with --model provider/model; no persistent state was created.");
    return { identity, model };
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!identity) identity = (await prompt.question("Stable Memory Identity: ")).trim();
    if (!identity) fail("Init requires a non-empty stable Memory Identity.");
    if (!model) {
      const piHome = join(home, ".pi", "agent");
      const runtime = await ModelRuntime.create({ authPath: join(piHome, "auth.json"), modelsPath: join(piHome, "models.json"), allowModelNetwork: false });
      const models = (await runtime.getAvailable()).map((entry) => `${entry.provider}/${entry.id}`);
      if (!models.length) fail("No authenticated model is available; manage credentials through ordinary Pi.");
      process.stdout.write(models.map((name, index) => `  ${index + 1}) ${name}`).join("\n") + "\n");
      const selected = Number((await prompt.question("Authenticated model number: ")).trim());
      if (!Number.isInteger(selected) || selected < 1 || selected > models.length) fail("Select a valid authenticated model number.");
      model = models[selected - 1];
    }
    return { identity, model };
  } finally { prompt.close(); }
}

const args = normalizeAndValidateArgs(process.argv.slice(2));
if (args.includes("--help") || args.includes("-h")) process.stdout.write(HELP);
else {
  if (process.env.FEISHU_AGENT_INSPECT === "1") inspect();
  else if (args[0] === "init") {
    const home = realpathSync(homedir());
    const agentHome = join(home, ".feishu-agent");
    const identityIndex = args.indexOf("--identity");
    const modelIndex = args.indexOf("--model");
    const choices = await promptInitChoices(
      home,
      agentHome,
      identityIndex >= 0 ? args[identityIndex + 1] : process.env.FEISHU_MEMORY_IDENTITY,
      modelIndex >= 0 ? args[modelIndex + 1] : undefined,
      args.includes("--reset-identity"),
      args.includes("--reset-model"),
    );
    const result = initializeHome(agentHome, choices.identity, { identity: args.includes("--reset-identity"), system: args.includes("--reset-system") });
    const thinkingIndex = args.indexOf("--thinking");
    const thinking = thinkingIndex >= 0 ? args[thinkingIndex + 1] as ThinkingLevel : undefined;
    const readiness = await checkReadiness(home, agentHome, choices.model, { resetModel: args.includes("--reset-model"), thinkingLevel: thinking })
      .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
    const root = projectRoot(realpathSync(process.cwd()));
    const manager = packageManager(agentHome, root, projectKeyFor(root));
    if (!manager.listConfiguredPackages().some((entry) => entry.scope === "user" && entry.source === MEM0_PACKAGE && entry.installedPath)) {
      await manager.installAndPersist(MEM0_PACKAGE);
    }
    const skills = await syncOfficialSkills(join(agentHome, "official-skills"));
    if (skills.warning) {
      if (!existsSync(join(skills.cacheDir, ".success"))) fail(skills.warning);
      process.stderr.write(`Startup Warning: ${skills.warning}\n`);
    }
    process.stdout.write(`Feishu Agent Home: ${agentHome}\nMemory Identity: ${result.identity}\nModel: ${readiness.model}\nMem0 Package: ready\nOfficial Skills: ${skills.version}\nLark doctor: ${readiness.doctor}\nMemory: ${readiness.memory}\n`);
  }
  else if (args[0] === "skills" && args[1] === "sync") {
    const agentHome = join(realpathSync(homedir()), ".feishu-agent");
    try {
      const result = await syncOfficialSkills(join(agentHome, "official-skills"), true);
      process.stdout.write(`Synchronized official Skills for ${result.version}.\n`);
    } catch (error) {
      fail(`Official Skill synchronization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  else if (args[0] === "config") {
    const cwd = realpathSync(process.cwd());
    const root = projectRoot(cwd);
    const agentHome = join(realpathSync(homedir()), ".feishu-agent");
    if (args.includes("set")) {
      const local = args.includes("-l") || args.includes("--local");
      const setIndex = args.indexOf("set");
      const source = args[setIndex + 1];
      const resource = args[setIndex + 2] as PackageResourceType | undefined;
      const state = args[setIndex + 3];
      if (!source || !resource || !["extensions", "skills", "prompts", "themes"].includes(resource) || !["on", "off"].includes(state ?? "")) fail("Usage: feishu config [-l] set <source> <extensions|skills|prompts|themes> <on|off>");
      await setPackageResourceEnabled({ agentHome, projectRoot: root, projectKey: projectKeyFor(root), local, source, resource, enabled: state === "on" });
      process.stdout.write(`${local ? "Project" : "Global"} Feishu Package ${source} ${resource}: ${state}\n`);
    } else {
      const code = await dispatchConfig({ agentHome, projectRoot: root, projectKey: projectKeyFor(root), args: args.slice(1) });
      process.exitCode = code;
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
  else if (args.length === 0 || args[0] === "-c" || args[0] === "-r" || args[0] === "--session") {
    const cwd = realpathSync(process.cwd());
    const root = projectRoot(cwd);
    const agentHome = join(realpathSync(homedir()), ".feishu-agent");
    runInteractive(cwd, root, projectKeyFor(root), agentHome, args[0] === "-c", args[0] === "-r", args[0] === "--session" ? args[1] : undefined)
      .catch((error: unknown) => { process.stderr.write(`Feishu Agent: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
  } else {
    process.stderr.write("Feishu Agent runtime is not initialized. Run `feishu init`.\n");
    process.exitCode = 1;
  }
}
