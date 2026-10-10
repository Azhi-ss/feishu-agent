import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
export interface ReadinessOptions {
  selectModel?: (models: string[]) => Promise<string | undefined>;
  resetModel?: boolean;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
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
  return { model: `${settings.defaultProvider}/${settings.defaultModel}`, thinking: settings.defaultThinkingLevel, doctor: "passed" };
}
