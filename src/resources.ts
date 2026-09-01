import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createExtensionRuntime,
  DefaultResourceLoader,
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
import { DEFAULT_SYSTEM } from "./init.js";

function read(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

export class FeishuResourceLoader implements ResourceLoader {
  private skills: Skill[] = [];
  private agentsFiles: Array<{ path: string; content: string }> = [];
  private prompt = DEFAULT_SYSTEM;
  private extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() } as ReturnType<ResourceLoader["getExtensions"]>;
  private prompts: ReturnType<ResourceLoader["getPrompts"]> = { prompts: [], diagnostics: [] };
  private themes: ReturnType<ResourceLoader["getThemes"]> = { themes: [], diagnostics: [] };
  readonly warnings: string[] = [];

  private sessionSwitcher?: (path: string) => Promise<void>;
  private memoryDiagnostic?: () => string | undefined;
  private extensionLoader?: DefaultResourceLoader;
  private extensionPathsKey = "";

  constructor(private readonly agentHome: string, private readonly projectRoot: string, private readonly projectKey = "project", private readonly currentRequest?: string, private readonly memoryExtension?: import("@earendil-works/pi-coding-agent").ExtensionFactory) {}

  setSessionSwitcher(sessionSwitcher?: (path: string) => Promise<void>): void {
    this.sessionSwitcher = sessionSwitcher;
  }

  setMemoryDiagnostic(memoryDiagnostic?: () => string | undefined): void {
    this.memoryDiagnostic = memoryDiagnostic;
  }

  async reload(): Promise<void> {
    this.warnings.length = 0;
    const system = join(this.agentHome, "SYSTEM.md");
    const contextPaths = [join(this.projectRoot, ".feishu-agent", "AGENTS.md"), join(this.projectRoot, "AGENTS.md")];
    this.agentsFiles = contextPaths.flatMap((path) => {
      const content = read(path);
      return content === undefined ? [] : [{ path, content }];
    });
    this.prompt = [read(system) ?? DEFAULT_SYSTEM, ...this.agentsFiles.map((entry) => entry.content)].filter(Boolean).join("\n\n");

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
    const packageSkills = resolved.skills.filter((entry) => entry.enabled && entry.metadata.source !== "auto").flatMap((entry) => {
      const loaded = loadSkillsFromDir({ dir: entry.path, source: entry.metadata.source }).skills;
      return loaded.length ? loaded : loadSkillsFromDir({ dir: dirname(entry.path), source: entry.metadata.source }).skills.filter((skill) => skill.filePath === entry.path);
    });
    const extensionPaths = resolved.extensions.filter((entry) => entry.enabled).map((entry) => entry.path)
      .filter((path) => !path.includes("@mem0/pi-agent-plugin"));
    const extensionPathsKey = JSON.stringify(extensionPaths);
    if (!this.extensionLoader || this.extensionPathsKey !== extensionPathsKey) {
      this.extensionPathsKey = extensionPathsKey;
      this.extensionLoader = new DefaultResourceLoader({
        cwd: this.projectRoot,
        agentDir: this.agentHome,
        settingsManager: settingsManagerFor(this.agentHome, this.projectRoot),
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: extensionPaths,
        extensionFactories: [
          ...(this.memoryExtension ? [{ name: "feishu-memory", hidden: true, factory: this.memoryExtension }] : []),
          { name: "feishu-core-policy", hidden: true, factory: corePolicyExtension(this.currentRequest, this.sessionSwitcher, this.memoryDiagnostic, this) },
        ],
      });
    }
    await withCompatibilityHome(process.env.HOME!, this.agentHome, () => this.extensionLoader!.reload());
    this.extensions = this.extensionLoader.getExtensions();
    for (const extension of this.extensions.extensions) {
      if (extension.path === "<inline:feishu-core-policy>") continue;
      for (const reserved of CORE_TOOLS) if (extension.tools.delete(reserved)) this.warnings.push(`Extension ${extension.path} cannot replace reserved core tool ${reserved}.`);
      if (extension.commands.delete("feishu-resume")) this.warnings.push(`Extension ${extension.path} cannot replace reserved core command feishu-resume.`);
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
