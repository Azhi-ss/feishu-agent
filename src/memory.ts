import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryClient } from "mem0ai";
import {
  extractConversation,
  formatMemoryList,
  MEMORY_POLICY,
  registerCommands,
  registerMemoryTool,
  resolveSearchFilters,
  type Mem0Config,
  type ScopeContext,
} from "@mem0/pi-agent-plugin";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { withCompatibilityHome } from "./compatibility-home.js";
import { memoryWarning, redactSecrets } from "./memory-degradation.js";

export interface MemoryConfig {
  userId: string;
  autoCapture: true;
  defaultScope: "project";
  contextInjection: true;
  dream: { enabled: boolean; auto: boolean };
}

export function memoryConfig(identity: string): MemoryConfig {
  const normalized = identity.startsWith("feishu:") ? identity : `feishu:${identity}`;
  return { userId: normalized, autoCapture: true, defaultScope: "project", contextInjection: true, dream: { enabled: true, auto: true } };
}

export function writeMemoryConfig(agentHome: string, identity: string): string {
  const path = join(agentHome, "mem0-config.json");
  mkdirSync(agentHome, { recursive: true });
  writeFileSync(path, JSON.stringify(memoryConfig(identity), null, 2) + "\n", { mode: 0o600 });
  return path;
}

interface MemoryClientLike {
  ping(): Promise<void>;
  add(...args: any[]): Promise<any>;
  search(...args: any[]): Promise<any>;
  getAll(...args: any[]): Promise<any>;
  update(...args: any[]): Promise<any>;
  delete(...args: any[]): Promise<any>;
  deleteAll(...args: any[]): Promise<any>;
}

function safeClient(client: MemoryClientLike): MemoryClientLike {
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try { return await value.apply(target, args); }
        catch (error) { throw new Error(redactSecrets(error instanceof Error ? error.message : String(error))); }
      };
    },
  });
}

export interface MemoryRuntime {
  warning?: string;
  extension?: ExtensionFactory;
}

export async function memoryRuntime(
  agentHome: string,
  projectKey: string,
  createClient: (apiKey: string) => MemoryClientLike = (apiKey) => new MemoryClient({ apiKey }),
  timeoutMs = 2000,
): Promise<MemoryRuntime> {
  const apiKey = process.env.MEM0_API_KEY;
  if (!apiKey) return { warning: memoryWarning("load", new Error("MEM0_API_KEY is missing")) };
  let config: MemoryConfig;
  try { config = JSON.parse(readFileSync(join(agentHome, "mem0-config.json"), "utf8")); }
  catch (error) { return { warning: memoryWarning("load", error) }; }
  if (!config.userId?.startsWith("feishu:")) return { warning: memoryWarning("load", new Error("stable feishu:<identity> is not configured")) };

  const externalUserId = process.env.MEM0_USER_ID;
  let client: MemoryClientLike;
  try {
    client = await withCompatibilityHome(process.env.HOME!, agentHome, async () => {
      delete process.env.MEM0_USER_ID;
      try { return safeClient(createClient(apiKey)); }
      finally {
        if (externalUserId === undefined) delete process.env.MEM0_USER_ID;
        else process.env.MEM0_USER_ID = externalUserId;
      }
    });
    await Promise.race([
      client.ping(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`health check timed out after ${timeoutMs}ms`)), timeoutMs)),
    ]);
  } catch (error) { return { warning: memoryWarning("health", error) }; }

  const pluginConfig: Mem0Config = {
    apiKey: "",
    userId: config.userId,
    autoCapture: true,
    defaultScope: "project",
    contextInjection: true,
    searchThreshold: 0.3,
    dream: { enabled: false, auto: false, minHours: 24, minSessions: 5, minMemories: 20 },
  };
  const scope: ScopeContext = { userId: config.userId, appId: projectKey, runId: "unknown" };
  let degraded = false;
  const disable = (feature: "recall" | "capture", error: unknown) => {
    degraded = true;
    console.error(memoryWarning(feature, error));
  };
  const guardedClient = new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        if (degraded) throw new Error("Long-term Memory is disabled for this degraded session.");
        return value.apply(target, args);
      };
    },
  });
  const extension = (pi: ExtensionAPI) => {
    registerMemoryTool(pi, guardedClient as never, pluginConfig, () => scope);
    registerCommands(pi, guardedClient as never, pluginConfig, () => scope);
    pi.on("session_start", (_event, ctx) => {
      const file = ctx.sessionManager?.getSessionFile?.();
      scope.runId = file ?? "unknown";
    });
    pi.on("before_agent_start", async (event) => {
      if (degraded) return { systemPrompt: event.systemPrompt };
      let extra = MEMORY_POLICY;
      try {
        const result = await guardedClient.search((event.prompt ?? "").trim(), { filters: resolveSearchFilters("project", scope) });
        if (result.results?.length) extra += `\n\n<mem0-relevant-memories>\n${formatMemoryList(result.results)}\n</mem0-relevant-memories>`;
      } catch (error) { disable("recall", error); return { systemPrompt: event.systemPrompt }; }
      return { systemPrompt: `${event.systemPrompt ?? ""}\n\n${extra}` };
    });
    pi.on("agent_end", async (event) => {
      if (degraded) return;
      const conversation = extractConversation(event.messages ?? []);
      if (!conversation.length) return;
      try { await guardedClient.add(conversation, { userId: scope.userId, appId: scope.appId }); }
      catch (error) { disable("capture", error); }
    });
  };
  return { extension };
}
