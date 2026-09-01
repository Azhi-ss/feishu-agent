import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { redactSecrets } from "./memory-degradation.js";

export interface ReadinessOptions {
  selectModel?: (models: string[]) => Promise<string | undefined>;
  createMemoryClient?: (apiKey: string) => { ping(): Promise<void> };
  memoryTimeoutMs?: number;
  resetModel?: boolean;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

async function validateMemory(apiKey: string, timeoutMs: number): Promise<void> {
  const response = await fetch(`${process.env.MEM0_API_HOST ?? "https://api.mem0.ai"}/v1/ping/`, {
    headers: { Authorization: `Token ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object") throw new Error("Invalid response from Mem0 ping endpoint");
  const result = body as { status?: unknown; message?: unknown };
  if (result.status !== "ok") throw new Error(typeof result.message === "string" ? result.message : "Mem0 ping returned unsuccessful status");
}

export async function checkReadiness(home: string, agentHome: string, preferred?: string, options: ReadinessOptions = {}) {
  const piHome = join(home, ".pi", "agent");
  const runtime = await ModelRuntime.create({ authPath: join(piHome, "auth.json"), modelsPath: join(piHome, "models.json"), allowModelNetwork: false });
  const available = await runtime.getAvailable();
  if (!available.length) throw new Error("No authenticated model is available; manage credentials through ordinary Pi.");
  const names = available.map((model) => `${model.provider}/${model.id}`);
  const settingsPath = join(agentHome, "settings.json");
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  const existing = settings.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : undefined;
  let selectedName = existing && !options.resetModel ? existing : preferred;
  if (!selectedName) selectedName = await options.selectModel?.(names);
  if (!selectedName) throw new Error("Select an authenticated model explicitly with --model provider/model.");
  const selected = available.find((model) => `${model.provider}/${model.id}` === selectedName);
  if (!selected) {
    if (existing && !options.resetModel) throw new Error(`Existing Feishu default is unavailable: ${existing}. Rerun with --reset-model --model provider/model.`);
    throw new Error(`Authenticated model not found: ${selectedName}`);
  }

  const apiKey = process.env.MEM0_API_KEY;
  if (!apiKey) throw new Error("MEM0_API_KEY is missing.");
  try {
    if (options.createMemoryClient) await options.createMemoryClient(apiKey).ping();
    else await validateMemory(apiKey, options.memoryTimeoutMs ?? 3000);
  } catch (error) { throw new Error(`Mem0 validation failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`); }
  try {
    execFileSync("lark-cli", ["doctor"], { encoding: "utf8", env: process.env });
  } catch (error) {
    const failure = error as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number };
    const detail = [failure.stdout, failure.stderr].map((value) => value?.toString().trim()).filter(Boolean).join("\n");
    throw new Error(`Lark doctor failed${failure.status === undefined ? "" : ` (exit ${failure.status})`}${detail ? `: ${detail}` : "."}`);
  }
  let changed = false;
  if (options.resetModel || !settings.defaultProvider || !settings.defaultModel) {
    settings.defaultProvider = selected.provider;
    settings.defaultModel = selected.id;
    changed = true;
  }
  if (options.thinkingLevel && (options.resetModel || !settings.defaultThinkingLevel)) {
    settings.defaultThinkingLevel = options.thinkingLevel;
    changed = true;
  }
  if (changed) writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  return { model: `${settings.defaultProvider}/${settings.defaultModel}`, thinking: settings.defaultThinkingLevel, doctor: "passed", memory: "available" };
}
