import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createEventBus,
  createExtensionRuntime,
  DefaultResourceLoader,
  discoverAndLoadExtensions,
  loadSkillsFromDir,
  type ResourceLoader,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { packageManager } from "./packages.js";
import { syncOfficialSkills } from "./official-skills.js";
import { withCompatibilityHome } from "./compatibility-home.js";
import { CORE_TOOLS } from "./policy.js";
import { settingsManagerFor } from "./settings.js";
import { corePolicyExtension } from "./core-extension.js";

const BASE_IDENTITY = `You are Feishu Agent, the dedicated assistant operating Feishu Runtime for this Feishu Project.
Use Feishu Skills and optional Long-term Memory while preserving Lark Identity. An exact destructive request may be a High-risk Approval only for that exact operation.
You may inspect project material and create support files directly serving a Feishu deliverable or lark-cli workflow. Refer unrelated general software development to ordinary pi.
Resource Isolation is not filesystem isolation or an OS sandbox; tools retain the current user's permissions.
Use existing lark-cli state without copying tokens. Prefer lark-cli shortcuts; inspect --help or schema for unfamiliar commands. Personal-resource operations must explicitly use --as user. Use --as bot only when the user requests Bot identity or the API requires it.`;

function read(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

export class FeishuResourceLoader implements ResourceLoader {
  private skills: Skill[] = [];
  private agentsFiles: Array<{ path: string; content: string }> = [];
  private prompt = BASE_IDENTITY;
  private extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() } as ReturnType<ResourceLoader["getExtensions"]>;
  private prompts: ReturnType<ResourceLoader["getPrompts"]> = { prompts: [], diagnostics: [] };
  private themes: ReturnType<ResourceLoader["getThemes"]> = { themes: [], diagnostics: [] };
  readonly warnings: string[] = [];

  constructor(private readonly agentHome: string, private readonly projectRoot: string, private readonly projectKey = "project", private readonly currentRequest?: string, private readonly memoryExtension?: import("@earendil-works/pi-coding-agent").ExtensionFactory, private readonly selectSession = false) {}

  async reload(): Promise<void> {
    this.warnings.length = 0;
    const system = join(this.agentHome, "SYSTEM.md");
    const contextPaths = [join(this.projectRoot, ".feishu-agent", "AGENTS.md"), join(this.projectRoot, "AGENTS.md")];
    this.agentsFiles = contextPaths.flatMap((path) => {
      const content = read(path);
      return content === undefined ? [] : [{ path, content }];
    });
    this.prompt = [BASE_IDENTITY, read(system), ...this.agentsFiles.map((entry) => entry.content)].filter(Boolean).join("\n\n");

    const global = loadSkillsFromDir({ dir: join(this.agentHome, "skills"), source: "feishu-global-private" }).skills;
    const project = loadSkillsFromDir({ dir: join(this.projectRoot, ".feishu-agent", "skills"), source: "feishu-project-private" }).skills;
    const selected = new Map<string, Skill>();
    let official: Skill[] = [];
    try {
      const result = syncOfficialSkills(join(this.agentHome, "official-skills"));
      official = result.skills;
      if (result.warning) this.warnings.push(result.warning);
    } catch (error) { this.warnings.push(`Official Skills unavailable: ${error instanceof Error ? error.message : String(error)}`); }

    const manager = packageManager(this.agentHome, this.projectRoot, this.projectKey);
    const resolved = await manager.resolve(async () => "skip");
    const packageSkills = resolved.skills.filter((entry) => entry.enabled).flatMap((entry) => loadSkillsFromDir({ dir: entry.path, source: entry.metadata.source }).skills);
    const extensionPaths = resolved.extensions.filter((entry) => entry.enabled).map((entry) => entry.path)
      .filter((path) => !path.includes("@mem0/pi-agent-plugin"));
    this.extensions = extensionPaths.length
      ? await withCompatibilityHome(process.env.HOME!, this.agentHome, () => discoverAndLoadExtensions(extensionPaths, this.projectRoot, this.agentHome, createEventBus()))
      : { extensions: [], errors: [], runtime: createExtensionRuntime() };
    const core = new DefaultResourceLoader({
      cwd: this.projectRoot,
      agentDir: this.agentHome,
      settingsManager: settingsManagerFor(this.agentHome, this.projectRoot),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [
        ...(this.memoryExtension ? [{ name: "feishu-memory", hidden: true, factory: this.memoryExtension }] : []),
        { name: "feishu-core-policy", hidden: true, factory: corePolicyExtension(this.currentRequest, this.selectSession) },
      ],
    });
    await core.reload();
    this.extensions.extensions.push(...core.getExtensions().extensions);
    this.extensions.errors.push(...core.getExtensions().errors);
    for (const extension of this.extensions.extensions) {
      if (extension.path === "<inline:feishu-core-policy>") continue;
      for (const reserved of CORE_TOOLS) if (extension.tools.delete(reserved)) this.warnings.push(`Extension ${extension.path} cannot replace reserved core tool ${reserved}.`);
    }

    const packageResources = new DefaultResourceLoader({
      cwd: this.projectRoot,
      agentDir: this.agentHome,
      settingsManager: settingsManagerFor(this.agentHome, this.projectRoot),
      noExtensions: true, noSkills: true, noContextFiles: true,
      additionalPromptTemplatePaths: resolved.prompts.filter((entry) => entry.enabled).map((entry) => entry.path),
      additionalThemePaths: resolved.themes.filter((entry) => entry.enabled).map((entry) => entry.path),
      systemPrompt: this.prompt,
    });
    await packageResources.reload();
    this.prompts = packageResources.getPrompts();
    this.themes = packageResources.getThemes();

    for (const skill of [...official, ...packageSkills, ...global, ...project]) {
      const shadowed = selected.get(skill.name);
      if (shadowed) this.warnings.push(`Skill "${skill.name}" selected ${skill.filePath}; shadowed ${shadowed.filePath}`);
      selected.set(skill.name, skill);
    }
    this.skills = [...selected.values()];
  }

  getExtensions() { return this.extensions; }
  getSkills() { return { skills: this.skills, diagnostics: [] }; }
  getPrompts() { return this.prompts; }
  getThemes() { return this.themes; }
  getAgentsFiles() { return { agentsFiles: this.agentsFiles }; }
  getSystemPrompt() { return this.prompt; }
  getSystemPromptSource() { return undefined; }
  getAppendSystemPrompt() { return []; }
  getAppendSystemPromptSources() { return []; }
  extendResources() {}
}
