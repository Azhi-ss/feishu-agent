import { dirname, join } from "node:path";
import {
  type AgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  InteractiveMode,
  ModelRuntime,
  runPrintMode,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { ASK_USER_TOOL } from "./core-extension.js";
import { FeishuResourceLoader } from "./resources.js";
import { cwdMismatchNotice, sessionManagerFor } from "./sessions.js";
import { CORE_TOOLS } from "./policy.js";
import { settingsManagerFor, ensureDefaultTheme } from "./settings.js";

const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const PI_RESUME_NOTICE = /^To resume this session:\s+pi(?:\s+--session-dir\s+(?:'[^']*'|"[^"]*"|\S+))?\s+--session\s+(\S+)$/;

export function rewritePiResumeNotice(output: string): string {
  const match = PI_RESUME_NOTICE.exec(output.replace(ANSI_ESCAPE, "").trim());
  if (!match) return output;
  const command = process.env.FEISHU_RESUME_COMMAND ?? "feishu";
  return `To resume this Feishu session: ${command} --session ${match[1]}\n`;
}

function installResumeNoticeRewrite(): () => void {
  const stdout = process.stdout;
  const original = stdout.write.bind(stdout);
  const wrapped = ((chunk: string | Uint8Array, ...args: any[]) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(typeof args[0] === "string" ? args[0] as BufferEncoding : "utf8");
    return original(rewritePiResumeNotice(text), ...args);
  }) as typeof stdout.write;
  stdout.write = wrapped;
  return () => { if (stdout.write === wrapped) stdout.write = original; };
}

/**
 * Disable the Pi SDK's built-in startup network checks: the "new pi version
 * available — run pi update" notice and the "extension updates available — run
 * pi update --extensions" notice. Both are wrong entry points for Feishu (the
 * pinned pi-coding-agent version belongs to feishu's own package.json, and
 * `pi update --extensions` operates on ~/.pi/agent, a different package set).
 * Set only at Runtime entry, never for feishu init/install/update management
 * commands so npm installs still work. Does not block real model or lark
 * traffic.
 */
export function disablePiStartupNetworkChecks(env: NodeJS.ProcessEnv = process.env): void {
  env.PI_OFFLINE ??= "1";
}

export async function runtimeHostSwitchOverride(runtime: Pick<AgentSessionRuntime, "switchSession">, path: string, launchCwd: string): Promise<void> {
  await runtime.switchSession(path, { cwdOverride: launchCwd });
}

async function createRuntimeForMode(cwd: string, projectRoot: string, projectKey: string, agentHome: string, resume = false, currentRequest?: string, interactive = false, sessionId?: string) {
  disablePiStartupNetworkChecks();
  ensureDefaultTheme(join(agentHome, "settings.json"));
  const piHome = join(process.env.HOME!, ".pi", "agent");
  const modelRuntime = await ModelRuntime.create({ authPath: join(piHome, "auth.json"), modelsPath: join(piHome, "models.json"), allowModelNetwork: false });
  const settingsManager = settingsManagerFor(agentHome, projectRoot);
  const resourceLoader = new FeishuResourceLoader(agentHome, projectRoot, projectKey, currentRequest);
  let runtime: AgentSessionRuntime | undefined;
  if (interactive) resourceLoader.setSessionSwitcher(async (path) => {
    const originalCwd = (await import("@earendil-works/pi-coding-agent")).SessionManager.open(path).getCwd();
    const mismatch = cwdMismatchNotice(originalCwd, cwd);
    if (mismatch) process.stderr.write(`Session Notice: ${mismatch}\n`);
    if (!runtime) throw new Error("Feishu session selector is not ready.");
    await runtimeHostSwitchOverride(runtime, path, cwd);
  });
  const available = await modelRuntime.getAvailable();
  const configuredProvider = settingsManager.getDefaultProvider();
  const configuredModel = settingsManager.getDefaultModel();
  const hasConfiguredDefault = Boolean(configuredProvider && configuredModel);
  const model = hasConfiguredDefault
    ? available.find((entry) => entry.provider === configuredProvider && entry.id === configuredModel)
    : available[0];
  if (!model) {
    if (hasConfiguredDefault) throw new Error(`Configured Feishu default ${configuredProvider}/${configuredModel} is unavailable. Run \`feishu init --reset-model --model provider/model\` to select an authenticated model.`);
    throw new Error("No authenticated model is available. Manage model credentials with ordinary Pi, then run `feishu init`.");
  }

  const createSession: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, sessionManager, sessionStartEvent }) => {
    // dispose() marks this loader's extension runtime stale. /new, /fork, and
    // /resume reuse the loader, so each session has to load a fresh runtime.
    await resourceLoader.reload();
    if (!sessionStartEvent) for (const warning of resourceLoader.warnings) process.stderr.write(`Startup Warning: ${warning}\n`);
    const services = { cwd: runtimeCwd, agentDir: agentHome, modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
    const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, excludeTools: interactive ? [ASK_USER_TOOL] : undefined });
    created.session.setActiveToolsByName([...new Set([...CORE_TOOLS, ...created.session.getActiveToolNames()])]);
    return { ...created, services, diagnostics: [] };
  };
  const selected = await sessionManagerFor(agentHome, projectRoot, cwd, resume, sessionId);
  const notice = cwdMismatchNotice(selected.originalCwd, cwd);
  if (notice) process.stderr.write(`Session Notice: ${notice}\n`);
  runtime = await createAgentSessionRuntime(createSession, { cwd, agentDir: agentHome, sessionManager: selected.manager });
  return runtime;
}

const RUN_FAILURE_PREFIX = "Feishu run failed:";

/** Last assistant error in this turn, as one searchable stderr line. Aborts are left as Pi wrote them. */
export function runFailureLine(messages: readonly object[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; stopReason?: string; errorMessage?: unknown };
    if (message?.role !== "assistant" || message.stopReason !== "error" || typeof message.errorMessage !== "string") continue;
    const text = message.errorMessage.replace(/\s+/g, " ").trim();
    if (!text) continue;
    return `${RUN_FAILURE_PREFIX} ${text.slice(0, 240)}`;
  }
  return undefined;
}

/** Set by the automation runner. Not a CLI flag. Ignored unless this process is unattended. */
function unattendedTimeoutMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  if (env.FEISHU_UNATTENDED !== "1") return undefined;
  const raw = env.FEISHU_RUN_TIMEOUT_MS;
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) return undefined;
  const ms = Number(raw);
  return Number.isSafeInteger(ms) && ms <= 2_147_483_647 ? ms : undefined;
}

export async function runPrint(prompt: string, cwd: string, projectRoot: string, projectKey: string, agentHome: string, sessionId?: string): Promise<number> {
  const timeoutMs = unattendedTimeoutMs();
  // The supervisor may already be gone (it never signals a PID from the ledger).
  // This process has to notice its own deadline. unref so a finished run does not wait on it.
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    const label = timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)}m` : `${timeoutMs}ms`;
    process.stderr.write(`${RUN_FAILURE_PREFIX} timed out after ${label}\n`, () => process.exit(124));
  }, timeoutMs);
  timer?.unref();
  try {
    const runtime = await createRuntimeForMode(cwd, projectRoot, projectKey, agentHome, false, prompt, false, sessionId);
    process.stderr.write(`Feishu Session: ${runtime.session.sessionManager.getSessionId()}\n`);
    const history = runtime.session.state.messages.length;
    const code = await runPrintMode(runtime, { mode: "text", initialMessage: prompt });
    // runPrintMode disposes the runtime in its own finally (matching upstream main.js);
    // a second dispose re-emits session_shutdown on an invalidated extension ctx.
    // A continued session replays earlier turns; only this run's messages decide the exit code.
    const turn = runtime.session.state.messages.slice(history);
    const failure = runFailureLine(turn);
    if (failure) process.stderr.write(`${failure}\n`);
    if (code) return code;
    const approvalError = turn.flatMap((message) => message.role === "toolResult" && message.isError ? message.content : [])
      .find((part) => part.type === "text" && /High-risk lark-cli|Blocked lark-cli/.test(part.text));
    if (approvalError?.type === "text") {
      process.stderr.write(`${approvalError.text}\n`);
      return 3;
    }
    const asked = turn.find((message) => message.role === "toolResult" && message.toolName === ASK_USER_TOOL && !message.isError);
    if (asked?.role === "toolResult") {
      const { question, options = [] } = asked.details as { question: string; options?: string[] };
      process.stdout.write(`${[question, ...options.map((option, index) => `${index + 1}. ${option}`)].join("\n")}\n`);
      return 3;
    }
    return failure ? 1 : 0;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runInteractive(cwd: string, projectRoot: string, projectKey: string, agentHome: string, resume = false, selectSession = false, sessionId?: string): Promise<void> {
  const restoreResumeNotice = installResumeNoticeRewrite();
  let runtime: Awaited<ReturnType<typeof createRuntimeForMode>>;
  try {
    runtime = await createRuntimeForMode(cwd, projectRoot, projectKey, agentHome, resume, undefined, true, sessionId);
    await new InteractiveMode(runtime, { startupDiagnostics: [...runtime.diagnostics], initialMessage: selectSession ? "/feishu-resume" : undefined }).run();
  } finally {
    restoreResumeNotice();
    if (runtime!) await runtime.dispose();
  }
}
