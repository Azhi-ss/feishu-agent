import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  ModelRuntime,
  type ExtensionFactory,
  type ResourceLoader,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { authorizeLarkCommand } from "./high-risk.js";
import { CORE_TOOLS } from "./policy.js";
import { settingsManagerFor } from "./settings.js";

export interface FeishuSubagentContext {
  version: 1;
  agentHome: string;
  projectRoot: string;
  skills: Skill[];
  systemPrompt: string;
  approvedDestructive: boolean;
}

/** Immutable, credential-free handoff shared by foreground and detached children. */
export function publishFeishuSubagentContext(context: FeishuSubagentContext): void {
  const content = JSON.stringify(context);
  const directory = join(context.agentHome, "subagents", "contexts");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `${createHash("sha256").update(content).digest("hex")}.json`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
  try {
    // Publish only a complete file; another parent may publish the same snapshot.
    try { linkSync(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  process.env.FEISHU_SUBAGENT_HOST_MODULE = fileURLToPath(import.meta.url);
  process.env.FEISHU_SUBAGENT_CONTEXT = target;
  process.env.PI_SUBAGENTS_TEMP_ROOT = join(context.agentHome, "subagents", "runtime");
  process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
}

interface FeishuChildResourcesOptions {
  snapshot: FeishuSubagentContext;
  cwd: string;
  hooks: Array<{ name: string; factory: ExtensionFactory }>;
  extensionPaths: string[];
  systemPrompt?: string;
  appendSystemPrompt?: string;
}

/** Host-owned resource boundary used by the separately installed subagents fork. */
export async function createFeishuSubagentResources(options: FeishuChildResourcesOptions) {
  const { snapshot, cwd } = options;
  const settingsManager = settingsManagerFor(snapshot.agentHome, snapshot.projectRoot);
  // Agent Home is private; credentials remain at the existing ordinary Pi path.
  const piHome = join(dirname(snapshot.agentHome), ".pi", "agent");
  const modelRuntime = await ModelRuntime.create({
    authPath: join(piHome, "auth.json"), modelsPath: join(piHome, "models.json"), allowModelNetwork: false,
  });
  const policy: ExtensionFactory = (pi) => {
    pi.on("before_agent_start", (event) => {
      event.systemPromptOptions.skills = snapshot.skills;
      const base = snapshot.systemPrompt;
      return { systemPrompt: event.systemPrompt.startsWith(base) ? event.systemPrompt : `${base}\n\n${event.systemPrompt}` };
    });
    pi.on("tool_call", (event) => {
      if (event.toolName !== "bash") return;
      try { authorizeLarkCommand(String(event.input.command ?? ""), snapshot.approvedDestructive, true); }
      catch (error) {
        return { block: true, terminate: true, reason: error instanceof Error ? error.message : String(error) };
      }
    });
  };
  const resourceLoader: ResourceLoader = new DefaultResourceLoader({
    cwd, agentDir: snapshot.agentHome, settingsManager,
    noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: options.extensionPaths,
    extensionFactories: [...options.hooks, { name: "feishu-child-policy", factory: policy }],
    systemPrompt: [snapshot.systemPrompt, options.systemPrompt, options.appendSystemPrompt].filter(Boolean).join("\n\n"),
    skillsOverride: () => ({ skills: snapshot.skills, diagnostics: [] }),
    extensionsOverride: (loaded) => {
      for (const extension of loaded.extensions) {
        for (const tool of CORE_TOOLS) extension.tools.delete(tool);
      }
      return loaded;
    },
  });
  return { resourceLoader, settingsManager, modelRuntime };
}
