/**
 * Feishu delegation gateway for a host pi Agent.
 *
 * Thin shell over the `skills/feishu/feishu-send` distribution script. The delegation protocol
 * (modes, exit codes, session/profile/cwd continuation) lives there and in `skills/feishu/SKILL.md`;
 * this file adds only three things: a structured `feishu` tool, a session ledger, and a hard block on
 * direct `lark-cli` calls from the host's Bash. It carries no protocol logic of its own, so a broken
 * or missing extension still leaves the Skill bridge working.
 *
 * Host-only distribution resource. Not part of the repository's tsc build, and never installable as a
 * Feishu Package: installing it into `~/.feishu-agent/` would make the Feishu Agent call itself.
 * Install by symlinking this file into the host pi extensions directory (see README.md here).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const LEDGER_ENTRY = "feishu-delegate";

/** Locate `feishu-send` next to this file, resolving the install symlink when there is one. */
function sendScript(): string {
  const loaded = fileURLToPath(import.meta.url);
  for (const base of [realpathSync(loaded), resolve(loaded)]) {
    const candidate = join(dirname(base), "..", "skills", "feishu", "feishu-send");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`feishu-send not found next to this extension (${loaded}). Symlink the extension from the feishu-agent repository instead of copying it.`);
}

/** Feishu Project = Git root of the delegation directory, falling back to that directory (SPEC §4). */
function projectRoot(dir: string): string {
  const git = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return git.status === 0 && git.stdout.trim() ? git.stdout.trim() : dir;
}

/** Never echo a credential into the host transcript, even if a child process prints one. */
function redactedError(text: string): string {
  return text
    .replace(/(api[_-]?key|token|secret|password|authorization|bearer)\s*[:=]?\s*\S+/gi, "$1=[redacted]")
    .trim()
    .slice(0, 2000);
}

interface SendResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runSend(args: string[], cwd: string, signal?: AbortSignal): Promise<SendResult> {
  return new Promise((done, fail) => {
    const child = spawn("bash", args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    const abort = () => child.kill("SIGTERM");
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", abort);
      fail(error);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      done({ code: code ?? 1, stdout, stderr });
    });
  });
}

type Status = "answered" | "needs_user" | "timeout" | "failed";

interface Delegation {
  status: Status;
  session?: string;
  project: string;
  profile?: string;
}

/** Model-facing body plus the three continuation fields, so the host never has to parse raw stderr. */
function compose(delegation: Delegation, body: string): string {
  const session = delegation.session
    ? `Feishu Session: ${delegation.session} | project: ${delegation.project} | profile: ${delegation.profile ?? "default"}`
    : "Feishu Session: none";
  return `${body}\n\n${session}`;
}

function bodyFor(delegation: Delegation, result: SendResult): string {
  const stdout = result.stdout.trim();
  switch (delegation.status) {
    case "answered":
      return stdout || "(the Feishu Agent returned an empty reply)";
    case "needs_user":
      return `${stdout || redactedError(result.stderr)}\n\nFeishu Agent is waiting for the user; relay it verbatim and stop.`;
    case "timeout":
      return "Feishu delegation timed out; the work may be partially complete. Do not retry automatically.";
    default:
      return `Feishu delegation failed (exit ${result.code}): ${redactedError(result.stderr) || "no error output"}`;
  }
}

interface LedgerData {
  session: string;
  project: string;
  profile?: string;
  status: Status;
  at: number;
}

/** Latest ledger entry for this Feishu Project, so a continuation ID survives compaction. */
function ledgerNote(entries: Array<{ type: string; customType?: string; data?: unknown }>, project: string): string {
  const last = entries.filter((entry) => entry.type === "custom" && entry.customType === LEDGER_ENTRY && (entry.data as LedgerData)?.project === project).pop();
  if (!last) return "";
  const data = last.data as LedgerData;
  return `\n\nPrevious delegation in this project ended with status "${data.status}" (session ${data.session}). If this task continues that one, pass session: "${data.session}"; if it is a new task, ignore this.`;
}

export default function (pi: ExtensionAPI) {
  const feishu = defineTool({
    name: "feishu",
    label: "Feishu Agent",
    description: "Delegate any Feishu/Lark work to the Feishu Agent: messages, group chats, calendar and meetings, cloud docs, wiki, sheets, Base, approvals, minutes, tasks, contacts. Pass the user's request as `task`. Continue an earlier delegation with `session`; ask for verbatim content with mode \"raw\". Never call `lark-cli` directly: the Feishu Agent owns that.",
    promptSnippet: "feishu — delegate Feishu/Lark work (messages, calendar, docs, sheets, Base, approvals, minutes, tasks) to the Feishu Agent",
    promptGuidelines: [
      "Any Feishu/Lark request goes to the `feishu` tool; the host has no lark-* skill and must not call `lark-cli` itself.",
      "Continue a delegation by passing its `session`, and use `mode: \"raw\"` when you need the verbatim content for further work.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "The task for the Feishu Agent, in the user's own terms" }),
      session: Type.Optional(Type.String({ description: "Feishu session ID from an earlier delegation, to continue that same task" })),
      mode: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("raw")], { description: "summary (default) returns conclusions and links; raw returns verbatim content with sources" })),
      profile: Type.Optional(Type.String({ description: "lark-cli profile, only when the user named one" })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const script = sendScript();
      const project = projectRoot(process.env.FEISHU_CONTROL_CWD || ctx.cwd);
      const args = [script];
      if (params.profile) args.push("--profile", params.profile);
      if (params.session) args.push("--session", params.session);
      if (params.mode === "raw") args.push("--raw");
      args.push(params.task);

      const result = await runSend(args, ctx.cwd, signal);
      const session = /^Feishu Session: (\S+)$/m.exec(result.stderr)?.[1];
      const status: Status = result.code === 0 ? "answered" : result.code === 3 ? "needs_user" : result.code === 124 ? "timeout" : "failed";
      const delegation: Delegation = { status, session, project, profile: params.profile };

      let content = compose(delegation, bodyFor(delegation, result));
      if (!params.session) content += ledgerNote(ctx.sessionManager.getBranch(), project);
      if (session) pi.appendEntry<LedgerData>(LEDGER_ENTRY, { session, project, profile: params.profile, status, at: Date.now() });

      return {
        content: [{ type: "text", text: content }],
        details: { status, exitCode: result.code, session, project, profile: params.profile },
      };
    },
  });

  pi.registerTool(feishu);

  // The host has no lark-* skill and no direct lark-cli path; this is the code backstop for that rule.
  const directLarkCli = /(?:^|[\n;&|(]\s*)(?:(?:[\w.-]+=\S+|sudo|env)\s+)*(?:\S*\/)?lark-cli(?=\s|$)/;
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return undefined;
    const command = typeof event.input.command === "string" ? event.input.command : "";
    if (!directLarkCli.test(command)) return undefined;
    return { block: true, reason: "Direct lark-cli calls are blocked: Feishu/Lark work goes through the `feishu` tool, which delegates to the Feishu Agent. Re-issue this as a feishu task." };
  });
}
