import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export async function checkReadiness(home: string, agentHome: string, preferred?: string) {
  const piHome = join(home, ".pi", "agent");
  const runtime = await ModelRuntime.create({ authPath: join(piHome, "auth.json"), modelsPath: join(piHome, "models.json"), allowModelNetwork: false });
  const available = await runtime.getAvailable();
  const selected = preferred ? available.find((model) => `${model.provider}/${model.id}` === preferred) : available[0];
  if (!selected) throw new Error("No authenticated model is available; manage credentials through ordinary Pi.");
  if (!process.env.MEM0_API_KEY) throw new Error("MEM0_API_KEY is missing.");
  execFileSync("lark-cli", ["doctor"], { encoding: "utf8", env: process.env });
  const settingsPath = join(agentHome, "settings.json");
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  if (!settings.defaultProvider || !settings.defaultModel) {
    settings.defaultProvider = selected.provider; settings.defaultModel = selected.id;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  }
  return { model: `${settings.defaultProvider}/${settings.defaultModel}`, doctor: "passed", memory: "available" };
}
