import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryClient } from "mem0ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { redactSecrets } from "./memory-degradation.js";

export interface ReadinessOptions {
  selectModel?: (models: string[]) => Promise<string | undefined>;
  createMemoryClient?: (apiKey: string) => { ping(): Promise<void> };
  memoryTimeoutMs?: number;
  resetModel?: boolean;
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
  let selectedName = preferred ?? (options.resetModel ? undefined : existing);
  if (!selectedName && available.length > 1) selectedName = await options.selectModel?.(names);
  if (!selectedName && available.length > 1) throw new Error("Multiple authenticated models are available; select one explicitly with --model provider/model.");
  selectedName ??= names[0];
  const selected = available.find((model) => `${model.provider}/${model.id}` === selectedName);
  if (!selected) throw new Error(`Authenticated model not found: ${selectedName}`);

  const apiKey = process.env.MEM0_API_KEY;
  if (!apiKey) throw new Error("MEM0_API_KEY is missing.");
  try {
    const client = options.createMemoryClient?.(apiKey) ?? new MemoryClient({ apiKey });
    await Promise.race([
      client.ping(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Mem0 validation timed out")), options.memoryTimeoutMs ?? 3000)),
    ]);
  } catch (error) { throw new Error(`Mem0 validation failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`); }
  execFileSync("lark-cli", ["doctor"], { encoding: "utf8", env: process.env });
  if (options.resetModel || !settings.defaultProvider || !settings.defaultModel) {
    settings.defaultProvider = selected.provider;
    settings.defaultModel = selected.id;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  }
  return { model: `${settings.defaultProvider}/${settings.defaultModel}`, doctor: "passed", memory: "available" };
}
