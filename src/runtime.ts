import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  InteractiveMode,
  ModelRuntime,
  runPrintMode,
  SettingsManager,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

import { FeishuResourceLoader } from "./resources.js";
import { sessionManagerFor } from "./sessions.js";

const TOOLS = ["read", "edit", "write", "bash", "grep", "find", "ls"];

export async function createRuntime(cwd: string, projectRoot: string, projectKey: string, agentHome: string, resume = false) {
  const piHome = join(process.env.HOME!, ".pi", "agent");
  const modelRuntime = await ModelRuntime.create({ authPath: join(piHome, "auth.json"), modelsPath: join(piHome, "models.json"), allowModelNetwork: false });
  const settingsManager = SettingsManager.create(cwd, agentHome, { projectTrusted: true });
  const resourceLoader = new FeishuResourceLoader(agentHome, projectRoot, projectKey);
  await resourceLoader.reload();
  for (const warning of resourceLoader.warnings) process.stderr.write(`Startup Warning: ${warning}\n`);
  const available = await modelRuntime.getAvailable();
  const model = available.find((entry) => entry.provider === settingsManager.getDefaultProvider() && entry.id === settingsManager.getDefaultModel()) ?? available[0];
  if (!model) throw new Error("No authenticated model is available. Manage model credentials with ordinary Pi, then run `feishu init`.");

  const createSession: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, sessionManager, sessionStartEvent }) => {
    const services = { cwd: runtimeCwd, agentDir: agentHome, modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
    return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, tools: TOOLS })), services, diagnostics: [] };
  };
  return createAgentSessionRuntime(createSession, { cwd, agentDir: agentHome, sessionManager: sessionManagerFor(agentHome, projectRoot, cwd, resume) });
}

export async function runPrint(prompt: string, cwd: string, projectRoot: string, projectKey: string, agentHome: string): Promise<number> {
  const runtime = await createRuntime(cwd, projectRoot, projectKey, agentHome);
  try { return await runPrintMode(runtime, { mode: "text", initialMessage: prompt }); }
  finally { await runtime.dispose(); }
}

export async function runInteractive(cwd: string, projectRoot: string, projectKey: string, agentHome: string, resume = false): Promise<void> {
  const runtime = await createRuntime(cwd, projectRoot, projectKey, agentHome, resume);
  try { await new InteractiveMode(runtime, { startupDiagnostics: [...runtime.diagnostics] }).run(); }
  finally { await runtime.dispose(); }
}
