import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryClient } from "mem0ai";
import {
  DREAM_PROTOCOL,
  acquireDreamLock,
  checkCheapGates,
  checkMemoryGate,
  extractConversation,
  formatMemoryList,
  incrementSessionCount,
  MEMORY_POLICY,
  recordDreamCompletion,
  registerCommands,
  registerMemoryTool,
  releaseDreamLock,
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
  diagnostic: () => string | undefined;
}

interface DefaultMemoryClientConstructor {
  new(options: { apiKey: string; host?: string }): MemoryClientLike;
}

// Mem0 starts an untracked async initializer in its constructor. Override it so startup has only the awaited health ping below.
const DefaultMemoryClient = class extends (MemoryClient as unknown as DefaultMemoryClientConstructor) {
  _initializeClient(): void {}
};
const createDefaultClient = (apiKey: string) => new DefaultMemoryClient({ apiKey, ...(process.env.MEM0_API_HOST ? { host: process.env.MEM0_API_HOST } : {}) });

export async function memoryRuntime(
  agentHome: string,
  projectKey: string,
  createClient: (apiKey: string) => MemoryClientLike = createDefaultClient,
  timeoutMs = 2000,
): Promise<MemoryRuntime> {
  const apiKey = process.env.MEM0_API_KEY;
  let warning: string | undefined;
  const unavailable = (feature: "load" | "health", error: unknown): MemoryRuntime => {
    warning = memoryWarning(feature, error);
    return { warning, diagnostic: () => warning };
  };
  if (!apiKey) return unavailable("load", new Error("MEM0_API_KEY is missing"));
  let config: MemoryConfig;
  try { config = JSON.parse(readFileSync(join(agentHome, "mem0-config.json"), "utf8")); }
  catch (error) { return unavailable("load", error); }
  if (!config.userId?.startsWith("feishu:")) return unavailable("load", new Error("stable feishu:<identity> is not configured"));

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
  } catch (error) { return unavailable("load", error); }
  try {
    await Promise.race([
      client.ping(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`health check timed out after ${timeoutMs}ms`)), timeoutMs)),
    ]);
  } catch (error) { return unavailable("health", error); }

  const pluginConfig: Mem0Config = {
    apiKey: "",
    userId: config.userId,
    autoCapture: true,
    defaultScope: "project",
    contextInjection: true,
    searchThreshold: 0.3,
    dream: { enabled: config.dream.enabled, auto: config.dream.auto, minHours: 24, minSessions: 5, minMemories: 20 },
  };
  const dreamStateDir = join(agentHome, "memory-state");
  const scope: ScopeContext = { userId: config.userId, appId: projectKey, runId: "unknown" };
  let degraded = false;
  let dreamTriggered = false;
  let dreamWriteSucceeded = false;
  let dreamChecked = false;
  let notifyWarning: ((message: string) => void) | undefined;
  const disable = (feature: "load" | "recall" | "capture" | "dream", error: unknown) => {
    if (degraded) return;
    degraded = true;
    warning = memoryWarning(feature, error);
    process.stderr.write(`${warning}\n`);
    notifyWarning?.(warning);
  };
  const failDream = (error: unknown) => {
    if (dreamTriggered) releaseDreamLock(dreamStateDir);
    dreamTriggered = false;
    dreamWriteSucceeded = false;
    disable("dream", error);
  };
  const skipped = (property: PropertyKey) => {
    if (property === "search") return { results: [] };
    if (property === "getAll") return { results: [], count: 0 };
    if (property === "add") return [];
    return {};
  };
  const guardedClient = new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => degraded ? skipped(property) : value.apply(target, args);
    },
  });
  const extension = (pi: ExtensionAPI) => {
    pi.on("session_start", (_event, ctx) => {
      notifyWarning = (message) => ctx.ui.notify(message, "warning");
      if (warning) notifyWarning(warning);
      const file = ctx.sessionManager?.getSessionFile?.();
      scope.runId = file ?? "unknown";
      if (!degraded && pluginConfig.dream.enabled) incrementSessionCount(dreamStateDir, scope.runId);
    });
    try {
      const toolsApi = new Proxy(pi, {
        get(target, property) {
          if (property === "registerTool") return (tool: any) => pi.registerTool({
            ...tool,
            execute: async (...args: unknown[]) => {
              if (degraded) return { content: [{ type: "text", text: warning ?? "Long-term Memory is unavailable for this session." }], details: {} };
              try {
                const result = await tool.execute(...args);
                if (dreamTriggered && ["add", "delete", "delete_all"].includes((args[1] as { action?: string } | undefined)?.action ?? "")) dreamWriteSucceeded = true;
                return result;
              } catch (error) {
                if (!dreamTriggered) throw error;
                failDream(error);
                return { content: [{ type: "text", text: warning! }], details: {} };
              }
            },
          });
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      registerMemoryTool(toolsApi, guardedClient as never, pluginConfig, () => scope);
      const commandsApi = new Proxy(pi, {
        get(target, property) {
          if (property === "registerCommand") return (name: string, command: any) => {
            if (name !== "mem0-dream") pi.registerCommand(name, {
              ...command,
              handler: (...args: unknown[]) => {
                if (!degraded) return command.handler(...args);
                const ctx = args[1] as { ui?: { notify?: (message: string, level: "warning") => void } } | undefined;
                if (warning) ctx?.ui?.notify?.(warning, "warning");
              },
            });
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      registerCommands(commandsApi, guardedClient as never, pluginConfig, () => scope);
    } catch (error) { disable("load", error); }
    pi.registerCommand("mem0-dream", {
      description: "Consolidate memories — merge duplicates, prune stale entries, resolve contradictions",
      handler: async (_args, ctx) => {
        if (degraded) {
          if (warning) ctx.ui.notify(warning, "warning");
          return;
        }
        if (!acquireDreamLock(dreamStateDir)) {
          ctx.ui.notify("A dream consolidation is already in progress.", "warning");
          return;
        }
        dreamTriggered = true;
        try {
          pi.sendMessage({ customType: "mem0-dream", content: DREAM_PROTOCOL, display: false }, { triggerTurn: true });
          pi.sendMessage({ customType: "mem0-dream", content: "**Dreaming** — reviewing your memories to merge duplicates, resolve contradictions, and prune stale entries. I'll report what changed.", display: true });
        } catch (error) { failDream(error); }
      },
    });
    pi.on("before_agent_start", async (event) => {
      if (degraded) return { systemPrompt: event.systemPrompt };
      let extra = MEMORY_POLICY;
      try {
        const result = await guardedClient.search((event.prompt ?? "").trim(), { filters: resolveSearchFilters("project", scope) });
        if (result.results?.length) extra += `\n\n<mem0-relevant-memories>\n${formatMemoryList(result.results)}\n</mem0-relevant-memories>`;
      } catch (error) { disable("recall", error); return { systemPrompt: event.systemPrompt }; }
      if (pluginConfig.dream.enabled && pluginConfig.dream.auto && !dreamTriggered && !dreamChecked) {
        const gates = checkCheapGates(dreamStateDir, pluginConfig.dream);
        if (gates.proceed) {
          try {
            const all = await guardedClient.getAll({ filters: resolveSearchFilters("project", scope) });
            const count = all.count ?? all.results?.length ?? 0;
            dreamChecked = true;
            if (checkMemoryGate(count, pluginConfig.dream).pass && acquireDreamLock(dreamStateDir)) {
              dreamTriggered = true;
              extra += `\n\n${DREAM_PROTOCOL}`;
            }
          } catch (error) { disable("dream", error); return { systemPrompt: event.systemPrompt }; }
        }
      }
      return { systemPrompt: `${event.systemPrompt ?? ""}\n\n${extra}` };
    });
    pi.on("agent_end", async (event) => {
      if (degraded) return;
      const conversation = extractConversation(event.messages ?? []);
      if (conversation.length) {
        try { await guardedClient.add(conversation, { userId: scope.userId, appId: scope.appId }); }
        catch (error) { disable("capture", error); }
      }
      if (dreamTriggered) {
        if (dreamWriteSucceeded) recordDreamCompletion(dreamStateDir);
        releaseDreamLock(dreamStateDir);
        dreamTriggered = false;
        dreamWriteSucceeded = false;
      }
    });
    pi.on("session_shutdown", () => {
      if (dreamTriggered) releaseDreamLock(dreamStateDir);
      dreamTriggered = false;
      dreamWriteSucceeded = false;
    });
  };
  return { extension, diagnostic: () => warning };
}
