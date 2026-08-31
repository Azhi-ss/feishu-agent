import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createExtensionRuntime, loadSkillsFromDir, type ResourceLoader, type Skill } from "@earendil-works/pi-coding-agent";

const BASE_IDENTITY = `You are Feishu Agent, the dedicated assistant operating Feishu Runtime for this Feishu Project.
Use Feishu Skills and optional Long-term Memory while preserving Lark Identity. An exact destructive request may be a High-risk Approval only for that exact operation.
You may inspect project material and create support files directly serving a Feishu deliverable or lark-cli workflow. Refer unrelated general software development to ordinary pi.
Resource Isolation is not filesystem isolation or an OS sandbox; tools retain the current user's permissions.`;

function read(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

export class FeishuResourceLoader implements ResourceLoader {
  private skills: Skill[] = [];
  private agentsFiles: Array<{ path: string; content: string }> = [];
  private prompt = BASE_IDENTITY;
  readonly warnings: string[] = [];

  constructor(private readonly agentHome: string, private readonly projectRoot: string) {}

  async reload(): Promise<void> {
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
    for (const skill of [...global, ...project]) {
      const shadowed = selected.get(skill.name);
      if (shadowed) this.warnings.push(`Skill "${skill.name}" selected ${skill.filePath}; shadowed ${shadowed.filePath}`);
      selected.set(skill.name, skill);
    }
    this.skills = [...selected.values()];
  }

  getExtensions() { return { extensions: [], errors: [], runtime: createExtensionRuntime() }; }
  getSkills() { return { skills: this.skills, diagnostics: [] }; }
  getPrompts() { return { prompts: [], diagnostics: [] }; }
  getThemes() { return { themes: [], diagnostics: [] }; }
  getAgentsFiles() { return { agentsFiles: this.agentsFiles }; }
  getSystemPrompt() { return this.prompt; }
  getSystemPromptSource() { return undefined; }
  getAppendSystemPrompt() { return []; }
  getAppendSystemPromptSources() { return []; }
  extendResources() {}
}
