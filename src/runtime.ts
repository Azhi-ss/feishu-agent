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
import { FeishuResourceLoader } from "./resources.js";
import { cwdMismatchNotice, sessionManagerFor } from "./sessions.js";
import { CORE_TOOLS } from "./policy.js";
import { settingsManagerFor } from "./settings.js";
import { memoryRuntime } from "./memory.js";

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

export async function runtimeHostSwitchOverride(runtime: Pick<AgentSessionRuntime, "switchSession">, path: string, launchCwd: string): Promise<void> {
  await runtime.switchSession(path, { cwdOverride: launchCwd });
}

async function createRuntimeForMode(cwd: string, projectRoot: string, projectKey: string, agentHome: string, resume = false, currentRequest?: string, interactive = false, sessionId?: string) {
  const piHome = join(process.env.HOME!, ".pi", "agent");
  const modelRuntime = await ModelRuntime.create({ authPath: join(piHome, "auth.json"), modelsPath: join(piHome, "models.json"), allowModelNetwork: false });
  const settingsManager = settingsManagerFor(agentHome, projectRoot);
  const memory = await memoryRuntime(agentHome, projectKey);
  if (memory.warning) process.stderr.write(`${memory.warning}\n`);
  const resourceLoader = new FeishuResourceLoader(agentHome, projectRoot, projectKey, currentRequest, memory.extension);
  resourceLoader.setMemoryDiagnostic(memory.diagnostic);
  let runtime: AgentSessionRuntime | undefined;
  if (interactive) resourceLoader.setSessionSwitcher(async (path) => {
    const originalCwd = (await import("@earendil-works/pi-coding-agent")).SessionManager.open(path).getCwd();
    const mismatch = cwdMismatchNotice(originalCwd, cwd);
    if (mismatch) process.stderr.write(`Session Notice: ${mismatch}\n`);
    if (!runtime) throw new Error("Feishu session selector is not ready.");
    await runtimeHostSwitchOverride(runtime, path, cwd);
  });
  await resourceLoader.reload();
  for (const warning of resourceLoader.warnings) process.stderr.write(`Startup Warning: ${warning}\n`);
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
    const services = { cwd: runtimeCwd, agentDir: agentHome, modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
    const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model });
    created.session.setActiveToolsByName([...new Set([...CORE_TOOLS, ...created.session.getActiveToolNames()])]);
    return { ...created, services, diagnostics: [] };
  };
  const selected = await sessionManagerFor(agentHome, projectRoot, cwd, resume, sessionId);
  const notice = cwdMismatchNotice(selected.originalCwd, cwd);
  if (notice) process.stderr.write(`Session Notice: ${notice}\n`);
  runtime = await createAgentSessionRuntime(createSession, { cwd, agentDir: agentHome, sessionManager: selected.manager });
  return runtime;
}

export async function createRuntime(cwd: string, projectRoot: string, projectKey: string, agentHome: string, resume = false, currentRequest?: string) {
  return createRuntimeForMode(cwd, projectRoot, projectKey, agentHome, resume, currentRequest);
}

export async function runPrint(prompt: string, cwd: string, projectRoot: string, projectKey: string, agentHome: string): Promise<number> {
  const runtime = await createRuntime(cwd, projectRoot, projectKey, agentHome, false, prompt);
  try {
    const code = await runPrintMode(runtime, { mode: "text", initialMessage: prompt });
    if (code) return code;
    const approvalError = runtime.session.state.messages.flatMap((message) => message.role === "toolResult" && message.isError ? message.content : [])
      .find((part) => part.type === "text" && /High-risk Approval required|Blocked .*lark-cli/.test(part.text));
    if (approvalError?.type === "text") {
      process.stderr.write(`${approvalError.text}\n`);
      return 1;
    }
    return 0;
  }
  finally { await runtime.dispose(); }
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
