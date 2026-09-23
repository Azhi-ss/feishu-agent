#!/usr/bin/env node
import { automationCommand } from "./automation-commands.js";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function invalidOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-") || !value.trim()) fail(`${flag} requires a value.`);
  return value;
}

// Strict per-verb parser for the automation surface. Unknown options (for
// example update --name, or add/update --purge) fail before any mutation.
// Service commands accept no flags and never run on ordinary startup.
const ADD_UPDATE_VALUE_FLAGS = new Set(["--name", "--at", "--cron", "--every", "--tz", "--timeout", "--prompt-file", "--catch-up", "--lark-profile"]);
const ADD_UPDATE_BOOL_FLAGS = new Set(["--prompt-stdin", "--yes", "--no-catch-up"]);
const RM_VALUE_FLAGS = new Set<string>();
const RM_BOOL_FLAGS = new Set(["--purge", "--yes"]);

function normalizeAutomationArgs(input: string[]): string[] {
  const verb = input[1];
  const known = new Set(["list", "show", "add", "run", "serve", "update", "pause", "resume", "cancel", "rm", "start", "stop", "status"]);
  if (!verb || !known.has(verb)) {
    fail(`Unknown automation command: ${verb ?? ""}. Supported: feishu-automation list|show|add|update|run|pause|resume|cancel|rm|serve|start|stop|status.`);
  }
  if (["list", "serve", "start", "stop", "status"].includes(verb)) {
    if (input.length !== 2) fail(`Usage: feishu-automation ${verb}`);
    return input;
  }
  if (["show", "run", "pause", "resume", "cancel"].includes(verb)) {
    const rest = input.slice(2);
    if (rest.length !== 1 || rest[0].startsWith("-")) fail(`Usage: feishu-automation ${verb} <name>`);
    return input;
  }
  if (verb === "rm") {
    const rest = input.slice(2);
    if (rest.length < 1 || rest[0].startsWith("-")) fail(`Usage: feishu-automation rm <name> [--purge] [--yes]`);
    const options = rest.slice(1);
    // --yes confirms only the destructive purge; ordinary retained removal
    // needs no confirmation, so a bare --yes is an unsupported combination.
    if (options.includes("--yes") && !options.includes("--purge")) {
      fail("Use --yes only with --purge; ordinary feishu-automation rm needs no confirmation.");
    }
    validateAutomationFlags(options, verb, RM_VALUE_FLAGS, RM_BOOL_FLAGS);
    return input;
  }
  if (verb === "update") {
    const rest = input.slice(2);
    if (rest.length < 1 || rest[0].startsWith("-")) fail(`Usage: feishu-automation update <name> [options] [--yes]`);
    // --name is add-only: an update can never rename a job; --purge belongs to rm.
    validateAutomationFlags(rest.slice(1), verb, new Set([...ADD_UPDATE_VALUE_FLAGS].filter((flag) => flag !== "--name")), ADD_UPDATE_BOOL_FLAGS);
    return input;
  }
  // add
  validateAutomationFlags(input.slice(2), verb, ADD_UPDATE_VALUE_FLAGS, ADD_UPDATE_BOOL_FLAGS);
  return input;
}

function validateAutomationFlags(rest: string[], verb: string, valueFlags: Set<string>, boolFlags: Set<string>): void {
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index];
    if (!token.startsWith("--")) fail(`Unexpected automation ${verb} argument: ${token}.`);
    if (flags.has(token)) {
      if (token === "--at" || token === "--cron" || token === "--every") {
        fail(`${token} may be specified only once; provide exactly one schedule (--at, --cron, or --every).`);
      }
      fail(`${token} may be specified only once.`);
    }
    if (valueFlags.has(token)) {
      invalidOptionValue(rest, index, token);
      flags.add(token);
      index++;
    } else if (boolFlags.has(token)) {
      flags.add(token);
    } else {
      fail(`Unknown option for automation ${verb}: ${token}. Supported schedules are --at (one-shot), --cron (five fields), and --every (interval).`);
    }
  }
}


const input = process.argv.slice(2);
if (input.length === 1 && ["--help", "-h"].includes(input[0])) {
  process.stdout.write(`Usage:
  feishu-automation list         List saved Automation Jobs
  feishu-automation show <name>  Inspect one Automation Job and its latest run
  feishu-automation add --name <slug> (--at <ISO-time> | --cron "<5 fields>" | --every <duration>)
                 (--prompt-file <path> | --prompt-stdin)
                 [--tz <IANA>] [--catch-up <duration>|--no-catch-up] [--timeout <duration>] [--yes]
                                  Create a one-shot, cron, or fixed-interval Automation Job
  feishu-automation update <name> [any add option except --name] [--yes]
                                  Change an existing job; unspecified values are retained
  feishu-automation pause <name>  Stop new admission (a current run continues)
  feishu-automation resume <name> Skip the paused period without replay and re-enable
  feishu-automation cancel <name> Cancel the job's active run through its owner
  feishu-automation rm <name> [--purge] [--yes]
                                  Remove a job (records retained; --purge deletes them)
  feishu-automation run <name>   Run a saved job once now in a fresh unattended Print
  feishu-automation start        Explicitly install/start the user-service Trigger
  feishu-automation stop         Disable background restart; retain jobs and history
  feishu-automation status       Inspect live Trigger and user-service ownership
  feishu-automation serve        Run the foreground scheduling Trigger (one per managed workspace)
`);
} else {
  const args = normalizeAutomationArgs(["automation", ...input]);
  try { process.exitCode = await automationCommand(args); }
  catch (error) { fail(`Automation: ${error instanceof Error ? error.message : String(error)}`); }
}
