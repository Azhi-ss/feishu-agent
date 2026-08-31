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

export async function runtimeHostSwitchOverride(runtime: Pick<AgentSessionRuntime, "switchSession">, path: string, launchCwd: string): Promise<void> {
  await runtime.switchSession(path, { cwdOverride: launchCwd });
}

async function createRuntimeForMode(cwd: string, projectRoot: string, projectKey: string, agentHome: string, resume = false, currentRequest?: string, interactive = false) {
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
  const model = available.find((entry) => entry.provider === settingsManager.getDefaultProvider() && entry.id === settingsManager.getDefaultModel()) ?? available[0];
  if (!model) throw new Error("No authenticated model is available. Manage model credentials with ordinary Pi, then run `feishu init`.");

  const createSession: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, sessionManager, sessionStartEvent }) => {
    const services = { cwd: runtimeCwd, agentDir: agentHome, modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
    return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, tools: [...CORE_TOOLS] })), services, diagnostics: [] };
  };
  const selected = await sessionManagerFor(agentHome, projectRoot, cwd, resume);
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
  try { return await runPrintMode(runtime, { mode: "text", initialMessage: prompt }); }
  finally { await runtime.dispose(); }
}

export async function runInteractive(cwd: string, projectRoot: string, projectKey: string, agentHome: string, resume = false, selectSession = false): Promise<void> {
  const runtime = await createRuntimeForMode(cwd, projectRoot, projectKey, agentHome, resume, undefined, true);
  try { await new InteractiveMode(runtime, { startupDiagnostics: [...runtime.diagnostics], initialMessage: selectSession ? "/feishu-resume" : undefined }).run(); }
  finally { await runtime.dispose(); }
}
