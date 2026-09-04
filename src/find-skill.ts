import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";

const SEARCH_RESULT_LIMIT = "20";
const SEARCH_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const SKILL_NAME = /^(?=.{1,64}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const REPOSITORY_PART = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;
const ANSI_AND_CONTROL = /[\u0000-\u001f\u007f\u0080-\u009f]/g;

export interface SkillSearchResult {
  name: string;
  slug: string;
  source: string;
  installs: number;
}

export interface SkillMetadata {
  name: string;
  description: string;
  license?: string;
}

export interface ParsedSkillSpec {
  source: string;
  name: string;
  spec: string;
}

export type SkillsCliRunner = (args: readonly string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<void>;

interface StagedSkill {
  parsed: ParsedSkillSpec;
  metadata: SkillMetadata;
  directory: string;
  home: string;
}

function cleanText(value: unknown, max = 1024): string {
  return typeof value === "string" ? value.replace(ANSI_AND_CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function isRepository(value: string): boolean {
  const parts = value.split("/");
  return parts.length === 2 && parts.every((part) => REPOSITORY_PART.test(part));
}

function isSkillName(value: string): boolean {
  return SKILL_NAME.test(value) && !value.includes("--");
}

function sourceFromSlug(slug: string): string | undefined {
  const parts = slug.split("/").filter(Boolean);
  const source = parts.slice(0, 2).join("/");
  return isRepository(source) ? source : undefined;
}

export function parseSkillSpec(input: string): ParsedSkillSpec {
  const value = input.trim();
  const at = value.lastIndexOf("@");
  const source = at > 0 ? value.slice(0, at) : "";
  const name = at > 0 ? value.slice(at + 1) : "";
  if (!isRepository(source) || !isSkillName(name)) throw new Error("Skill source must look like owner/repo@skill-name.");
  return { source, name, spec: `${source}@${name}` };
}

export function skillSpec(result: SkillSearchResult): string | undefined {
  const source = isRepository(result.source) ? result.source : sourceFromSlug(result.slug);
  return source && isSkillName(result.name) ? `${source}@${result.name}` : undefined;
}

function searchBase(): string {
  return process.env.FEISHU_SKILLS_API_URL ?? process.env.SKILLS_API_URL ?? "https://skills.sh";
}

function responseSkills(body: unknown): unknown[] {
  if (!body || typeof body !== "object" || !Array.isArray((body as { skills?: unknown }).skills)) {
    throw new Error("Skill search returned an invalid response.");
  }
  return (body as { skills: unknown[] }).skills;
}

export async function searchSkills(query: string, fetcher: typeof fetch = globalThis.fetch): Promise<SkillSearchResult[]> {
  const normalized = query.trim();
  if (normalized.length < 2) throw new Error("Skill search requires at least two characters.");
  const url = new URL("/api/search", searchBase());
  url.searchParams.set("q", normalized);
  url.searchParams.set("limit", SEARCH_RESULT_LIMIT);
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    response = await fetcher(url, { signal: controller.signal });
  } catch {
    throw new Error("Skill search failed. Check the network and try again.");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`Skill search failed (HTTP ${response.status}).`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Skill search returned invalid JSON.");
  }
  const results = responseSkills(body).flatMap((entry): SkillSearchResult[] => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as Record<string, unknown>;
    const name = cleanText(value.name, 64);
    const slug = cleanText(value.id, 256);
    const rawSource = cleanText(value.source, 256);
    const source = isRepository(rawSource) ? rawSource : sourceFromSlug(slug);
    if (!source || !isSkillName(name)) return [];
    const installs = typeof value.installs === "number" && Number.isFinite(value.installs) && value.installs > 0 ? Math.floor(value.installs) : 0;
    return [{ name, slug, source, installs }];
  });
  return results.sort((a, b) => b.installs - a.installs || a.name.localeCompare(b.name)).slice(0, Number(SEARCH_RESULT_LIMIT));
}

function formatInstalls(count: number): string {
  if (!count) return "install count unavailable";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M installs`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K installs`;
  return `${count} install${count === 1 ? "" : "s"}`;
}

export function formatSearchResults(results: SkillSearchResult[]): string {
  return results.map((result) => {
    const spec = skillSpec(result) ?? `${result.source}@${result.name}`;
    return `${spec} · ${formatInstalls(result.installs)} · https://skills.sh/${result.slug}`;
  }).join("\n");
}

function parseScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return cleanText(JSON.parse(trimmed)); } catch { return cleanText(trimmed.slice(1, -1)); }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return cleanText(trimmed.slice(1, -1).replace(/''/g, "'"));
  return cleanText(trimmed);
}

function frontmatter(content: string): Map<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) throw new Error("Selected source does not contain a valid SKILL.md frontmatter block.");
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (field) fields.set(field[1], parseScalar(field[2]));
  }
  return fields;
}

async function readSkillMetadata(directory: string, expectedName: string): Promise<SkillMetadata> {
  const path = join(directory, "SKILL.md");
  const stat = await lstat(path).catch(() => undefined);
  if (!stat || !stat.isFile()) throw new Error("Selected source does not contain a regular SKILL.md file.");
  const fields = frontmatter(await readFile(path, "utf8"));
  const name = fields.get("name") ?? "";
  const description = fields.get("description") ?? "";
  const license = fields.get("license") || undefined;
  if (!isSkillName(name) || name !== expectedName) throw new Error(`Selected SKILL.md name must be ${expectedName}.`);
  if (!description) throw new Error("Selected SKILL.md must declare a description.");
  return { name, description, ...(license ? { license } : {}) };
}

async function locateSkillDirectory(root: string, expectedName: string): Promise<{ directory: string; metadata: SkillMetadata }> {
  const expected = join(root, expectedName);
  try { return { directory: expected, metadata: await readSkillMetadata(expected, expectedName) }; } catch {}
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const matches: Array<{ directory: string; metadata: SkillMetadata }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    try { matches.push({ directory, metadata: await readSkillMetadata(directory, expectedName) }); } catch {}
  }
  if (matches.length !== 1) throw new Error("The skills CLI did not produce exactly one valid selected Skill.");
  return matches[0];
}

async function copyTree(source: string, destination: string): Promise<void> {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink()) throw new Error("Skill installation rejects symbolic links in the source tree.");
  if (!sourceStat.isDirectory()) throw new Error("Selected Skill source is not a directory.");
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const stat = await lstat(from);
    if (stat.isSymbolicLink()) throw new Error("Skill installation rejects symbolic links in the source tree.");
    if (stat.isDirectory()) await copyTree(from, to);
    else if (stat.isFile()) {
      await copyFile(from, to);
      await chmod(to, stat.mode & 0o777).catch(() => {});
    } else throw new Error("Skill installation rejects special files in the source tree.");
  }
}

function pathInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function targetPath(agentHome: string, name: string): string {
  const root = resolve(agentHome, "skills");
  const target = resolve(root, name);
  if (!pathInside(root, target)) throw new Error("Invalid Skill name: destination path escapes the Feishu private Skills directory.");
  return target;
}

async function runNpxSkills(args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    execFile("npx", [...args], { cwd, env, timeout: INSTALL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES }, (error) => {
      if (error) reject(new Error("The skills CLI failed. Check npx, network access, and the selected source."));
      else resolvePromise();
    });
  });
}

function stagingEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    npm_config_cache: join(home, ".npm"),
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    DO_NOT_TRACK: "1",
    DISABLE_TELEMETRY: "1",
    NO_COLOR: "1",
    CI: "1",
  };
  for (const key of Object.keys(env)) {
    if (/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY|CREDENTIAL)/i.test(key)) delete env[key];
  }
  delete env.PI_AGENT_DIR;
  delete env.PI_CODING_AGENT_DIR;
  delete env.NPM_CONFIG_PREFIX;
  delete env.npm_config_prefix;
  delete env.NPM_CONFIG_GLOBAL;
  delete env.npm_config_global;
  delete env.NPM_CONFIG_USERCONFIG;
  delete env.npm_config_userconfig;
  return env;
}

async function stageSkill(spec: string, runner: SkillsCliRunner = runNpxSkills): Promise<StagedSkill> {
  const parsed = parseSkillSpec(spec);
  const home = await mkdtemp(join(tmpdir(), "feishu-find-skill-"));
  const skillsRoot = join(home, ".pi", "agent", "skills");
  try {
    await mkdir(skillsRoot, { recursive: true });
    await runner([
      "--yes", "skills", "add", parsed.source,
      "--skill", parsed.name,
      "--global", "--agent", "pi", "--copy", "--yes",
    ], stagingEnvironment(home), home);
    const located = await locateSkillDirectory(skillsRoot, parsed.name);
    return { parsed, metadata: located.metadata, directory: located.directory, home };
  } catch (error) {
    await rm(home, { recursive: true, force: true }).catch(() => {});
    if (error instanceof Error && error.message.startsWith("The skills CLI")) throw error;
    throw error instanceof Error ? error : new Error("Skill staging failed.");
  }
}

async function finishStagedSkill(staged: StagedSkill, agentHome: string, overwrite: boolean): Promise<string> {
  const destination = targetPath(agentHome, staged.metadata.name);
  const root = dirname(destination);
  await mkdir(root, { recursive: true });
  const existing = await lstat(destination).catch(() => undefined);
  if (existing && !overwrite) throw new Error(`Skill ${staged.metadata.name} already exists at ${destination}.`);
  const temporary = await mkdtemp(join(root, `.${staged.metadata.name}-`));
  let backup: string | undefined;
  try {
    await copyTree(staged.directory, temporary);
    if (existing) {
      backup = await mkdtemp(join(root, `.${staged.metadata.name}-backup-`));
      await rm(backup, { recursive: true, force: true });
      await rename(destination, backup);
    }
    await rename(temporary, destination);
    if (backup) await rm(backup, { recursive: true, force: true }).catch(() => {});
    return destination;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    if (backup) {
      await rm(destination, { recursive: true, force: true }).catch(() => {});
      await rename(backup, destination).catch(() => {});
    }
    throw error instanceof Error ? error : new Error("Skill installation failed.");
  }
}

async function cleanupStagedSkill(staged: StagedSkill): Promise<void> {
  await rm(staged.home, { recursive: true, force: true }).catch(() => {});
}

export async function installSkillToFeishuHome(spec: string, agentHome: string, options: { overwrite?: boolean; runSkillsCli?: SkillsCliRunner } = {}): Promise<string> {
  const staged = await stageSkill(spec, options.runSkillsCli);
  try { return await finishStagedSkill(staged, agentHome, options.overwrite ?? false); }
  finally { await cleanupStagedSkill(staged); }
}

async function targetExists(agentHome: string, name: string): Promise<boolean> {
  return Boolean(await lstat(targetPath(agentHome, name)).catch(() => undefined));
}

function displayInstallCount(result?: SkillSearchResult): string {
  return result ? `Install count: ${formatInstalls(result.installs)}` : "Install count: unavailable (direct source)";
}

async function installInteractively(spec: string, agentHome: string, ctx: ExtensionCommandContext, result?: SkillSearchResult): Promise<void> {
  if (!ctx.hasUI || ctx.mode === "print") throw new Error("Skill installation requires Interactive UI confirmation; run it from Feishu Interactive mode.");
  const staged = await stageSkill(spec);
  try {
    const destination = targetPath(agentHome, staged.metadata.name);
    const exists = await targetExists(agentHome, staged.metadata.name);
    const summary = [
      `Source: ${staged.parsed.source}`,
      `Skill: ${staged.metadata.name}`,
      `Description: ${staged.metadata.description}`,
      displayInstallCount(result),
      `License: ${staged.metadata.license ?? "not declared"}`,
      `Target: ${destination}`,
      "",
      "Review third-party Skill content before enabling; it runs with current-user permissions.",
    ].join("\n");
    if (!await ctx.ui.confirm("Install Feishu Skill?", summary)) {
      ctx.ui.notify("Skill installation cancelled.", "info");
      return;
    }
    if (exists && !await ctx.ui.confirm("Overwrite existing Feishu Skill?", `${destination}\nThis replaces the current private Skill.`)) {
      ctx.ui.notify("Skill installation cancelled; existing Skill was unchanged.", "info");
      return;
    }
    const installed = await finishStagedSkill(staged, agentHome, exists);
    ctx.ui.notify(`Installed ${staged.metadata.name} at ${installed}`, "info");
    try { await ctx.reload(); }
    catch { ctx.ui.notify("Skill installed, but Runtime reload failed; restart Feishu Agent to load it.", "warning"); }
  } finally { await cleanupStagedSkill(staged); }
}

function reportCommandError(error: unknown, ctx: ExtensionCommandContext): void {
  const message = error instanceof Error ? error.message : "Skill command failed.";
  if (ctx.mode === "print") {
    process.stderr.write(`Feishu Skill: ${message}\n`);
    throw error instanceof Error ? error : new Error(message);
  }
  ctx.ui.notify(message, "error");
}

export function findSkillExtension(agentHome: string): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerCommand("find-skill", {
      description: "Search for and install Skills in the private Feishu Agent Skills directory",
      getArgumentCompletions: (prefix) => prefix === "" || "install".startsWith(prefix) ? [{ value: "install", label: "install <owner/repo@skill>" }] : null,
      handler: async (args, ctx) => {
        try {
          let input = args.trim();
          if (!input && ctx.hasUI) {
            const prompted = await ctx.ui.input("Search Skills", "technical writing, diagrams, ...");
            if (prompted === undefined) return;
            input = prompted.trim();
          }
          if (!input) throw new Error("Usage: /find-skill <query> or /find-skill install <owner/repo@skill>.");
          if (/^install(?:\s|$)/i.test(input)) {
            if (!ctx.hasUI || ctx.mode === "print") throw new Error("Skill installation requires Interactive UI confirmation; search is the only Print-mode operation.");
            await installInteractively(input.replace(/^install\s*/i, ""), agentHome, ctx);
            return;
          }
          const results = await searchSkills(input);
          if (!results.length) {
            const message = `No Skills found for "${input}".`;
            if (ctx.hasUI && ctx.mode !== "print") ctx.ui.notify(message, "info");
            else process.stdout.write(`${message}\n`);
            return;
          }
          if (!ctx.hasUI || ctx.mode === "print") {
            process.stdout.write(`${formatSearchResults(results)}\n`);
            return;
          }
          const options = results.map((result) => `${skillSpec(result)} · ${formatInstalls(result.installs)} · https://skills.sh/${result.slug}`);
          const selected = await ctx.ui.select("Select a Feishu Skill to install", options);
          if (!selected) return;
          const index = options.indexOf(selected);
          const result = results[index];
          const spec = result && skillSpec(result);
          if (!result || !spec) throw new Error("The selected Skill result is invalid.");
          await installInteractively(spec, agentHome, ctx, result);
        } catch (error) { reportCommandError(error, ctx); }
      },
    });
  };
}
