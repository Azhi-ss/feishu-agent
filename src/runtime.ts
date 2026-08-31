import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  ModelRuntime,
  runPrintMode,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

import { FeishuResourceLoader } from "./resources.js";

const TOOLS = ["read", "edit", "write", "bash", "grep", "find", "ls"];

export async function runPrint(prompt: string, cwd: string, projectRoot: string, projectKey: string, agentHome: string, sessionDir: string): Promise<number> {
  const piHome = join(process.env.HOME!, ".pi", "agent");
  const modelRuntime = await ModelRuntime.create({
    authPath: join(piHome, "auth.json"),
    modelsPath: join(piHome, "models.json"),
    allowModelNetwork: false,
  });
  const settingsManager = SettingsManager.create(cwd, agentHome, { projectTrusted: true });
  const resourceLoader = new FeishuResourceLoader(agentHome, projectRoot, projectKey);
  await resourceLoader.reload();
  for (const warning of resourceLoader.warnings) process.stderr.write(`Startup Warning: ${warning}\n`);
  const available = await modelRuntime.getAvailable();
  const provider = settingsManager.getDefaultProvider();
  const modelId = settingsManager.getDefaultModel();
  const model = available.find((entry) => entry.provider === provider && entry.id === modelId) ?? available[0];
  if (!model) throw new Error("No authenticated model is available. Manage model credentials with ordinary Pi, then run `feishu init`.");

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, sessionManager, sessionStartEvent }) => {
    const services = { cwd: runtimeCwd, agentDir: agentHome, modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
    return {
      ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, tools: TOOLS })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir: agentHome,
    sessionManager: SessionManager.create(cwd, sessionDir),
  });
  try {
    return await runPrintMode(runtime, { mode: "text", initialMessage: prompt });
  } finally {
    await runtime.dispose();
  }
}
