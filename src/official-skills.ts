import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const CLI_TIMEOUT_MS = 1500;
// `lark-cli update` runs a global npm install; the version/skill calls are local and fast.
const CLI_UPDATE_TIMEOUT_MS = 5 * 60 * 1000;

function safeVersion(version: string): string {
  return Buffer.from(version).toString("base64url");
}

function assertSkillName(name: string): void {
  if (name !== basename(name) || name === "." || name === ".." || name.includes("\0")) {
    throw new Error(`Official Skill name is not a single path segment: ${name}`);
  }
}

function skillRelativePath(skillName: string, entryPath: string): string {
  const parts = entryPath.split("/");
  if (parts[0] !== skillName || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Official Skill path is not confined to ${skillName}.`);
  }
  return parts.slice(1).join("/");
}

function listedEntries(payload: unknown): { path: string; isDir: boolean }[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { entries?: unknown }).entries)) {
    throw new Error("Official Skill file list format not recognized.");
  }
  const entries: { path: string; isDir: boolean }[] = [];
  for (const entry of (payload as { entries: unknown[] }).entries) {
    if (!entry || typeof entry !== "object") throw new Error("Official Skill file list format not recognized.");
    const path = (entry as { path?: unknown }).path;
    const isDir = (entry as { is_dir?: unknown }).is_dir;
    if (typeof path !== "string" || typeof isDir !== "boolean") throw new Error("Official Skill file list format not recognized.");
    entries.push({ path, isDir });
  }
  return entries;
}

// Reference files live inside the lark-cli binary. `skills read <name>` is only SKILL.md;
// the local cache must also materialize every file `skills list` reports under that skill.
async function exportEmbeddedFiles(skillName: string, directory: string, env: NodeJS.ProcessEnv): Promise<void> {
  const pending = [skillName];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const dirPath = pending.pop()!;
    if (seen.has(dirPath)) continue;
    seen.add(dirPath);
    const listed = listedEntries(JSON.parse(await runCli(["skills", "list", dirPath], env)) as unknown);
    for (const entry of listed) {
      const relative = skillRelativePath(skillName, entry.path);
      if (entry.isDir) {
        if (!relative) throw new Error(`Official Skill path is not confined to ${skillName}.`);
        pending.push(entry.path);
        continue;
      }
      if (relative === "SKILL.md") continue;
      if (!relative) throw new Error(`Official Skill path is not confined to ${skillName}.`);
      const destination = join(directory, relative);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, await runCli(["skills", "read", entry.path], env, CLI_TIMEOUT_MS, 8 * 1024 * 1024));
    }
  }
}

function skillNames(payload: unknown): string[] {
  if (Array.isArray(payload)) return payload.map(String);
  if (payload && typeof payload === "object" && Array.isArray((payload as { skills?: unknown }).skills)) {
    const names: string[] = [];
    for (const skill of (payload as { skills: unknown[] }).skills) {
      if (typeof skill === "string") names.push(skill);
      else if (skill && typeof skill === "object" && typeof (skill as { name?: unknown }).name === "string") names.push((skill as { name: string }).name);
    }
    return names;
  }
  throw new Error("Official Skill export format not recognized.");
}

export type OfficialSkillsResult = {
  version: string;
  cacheDir: string;
  skills: ReturnType<typeof loadSkillsFromDir>["skills"];
  source: "current" | "fallback" | "none";
  warning?: string;
};

export type OfficialSkillsOptions = {
  allowSync?: boolean;
  updateLarkCli?: boolean;
};

function cacheDirs(cacheRoot: string): string[] {
  if (!existsSync(cacheRoot)) return [];
  return readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(cacheRoot, entry.name, ".success")))
    .map((entry) => join(cacheRoot, entry.name))
    .sort((a, b) => {
      const aMarker = statSync(join(a, ".success")).mtimeMs;
      const bMarker = statSync(join(b, ".success")).mtimeMs;
      return bMarker - aMarker || b.localeCompare(a);
    });
}

function loadCached(cacheDir: string, source: "current" | "fallback"): OfficialSkillsResult {
  const version = readFileSync(join(cacheDir, ".success"), "utf8").trim();
  if (!version) throw new Error("Official Skill cache has an empty version marker.");
  const skills = loadSkillsFromDir({ dir: cacheDir, source: "lark-cli-official" }).skills;
  return { version, cacheDir, skills, source };
}

function latestValidCache(cacheRoot: string): OfficialSkillsResult | undefined {
  for (const cacheDir of cacheDirs(cacheRoot)) {
    try { return loadCached(cacheDir, "fallback"); }
    catch { /* Ignore incomplete or corrupt published caches. */ }
  }
  return undefined;
}

async function runCli(args: string[], env: NodeJS.ProcessEnv, timeoutMs = CLI_TIMEOUT_MS, maxBuffer = 1024 * 1024): Promise<string> {
  const result = await execFileAsync("lark-cli", args, {
    encoding: "utf8",
    env,
    timeout: timeoutMs,
    killSignal: "SIGTERM",
    maxBuffer,
    windowsHide: true,
  });
  return result.stdout;
}

// A global npm install can emit more than the 1 MB cap used by local calls.
const CLI_UPDATE_MAX_BUFFER = 16 * 1024 * 1024;

// Explicitly self-update lark-cli (network + global install). Only reachable from the
// user-typed `feishu skills sync --update`; never called from startup/init, preserving
// the zero-network startup invariant. A failure aborts the sync and leaves caches intact.
async function updateLarkCli(env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await runCli(["update", "--json"], env, CLI_UPDATE_TIMEOUT_MS, CLI_UPDATE_MAX_BUFFER);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`lark-cli update failed; official Skills left unchanged: ${detail}`);
  }
}

export async function syncOfficialSkills(
  cacheRoot: string,
  force = false,
  env = process.env,
  options: OfficialSkillsOptions = {},
): Promise<OfficialSkillsResult> {
  // Self-update first (and only when explicitly requested) so the version read below
  // sees the freshly installed CLI and the exported skills match that binary.
  if (options.updateLarkCli) await updateLarkCli(env);
  let version: string;
  try {
    version = (await runCli(["--version"], env)).trim();
    if (!version) throw new Error("lark-cli returned an empty version.");
  } catch (error) {
    if (force) throw error;
    const cached = latestValidCache(cacheRoot);
    if (cached) return { ...cached, warning: `Official Skills unavailable; using ${cached.version}.` };
    return {
      version: "unknown",
      cacheDir: join(cacheRoot, "unknown"),
      skills: [],
      source: "none",
      warning: "Official Skills are unavailable because lark-cli is not available.",
    };
  }

  const cacheDir = join(cacheRoot, safeVersion(version));
  const marker = join(cacheDir, ".success");
  if (!force && existsSync(marker)) {
    try {
      const current = loadCached(cacheDir, "current");
      if (current.version === version) return { ...current, version };
    } catch { /* Rebuild or fall back below. */ }
  }

  const useFallback = (error?: unknown): OfficialSkillsResult => {
    const cached = latestValidCache(cacheRoot);
    if (cached) return { ...cached, version, warning: `Official Skills for ${version} unavailable; using ${cached.version}.` };
    if (error && force) throw error;
    return { version, cacheDir, skills: [], source: "none", warning: `Official Skills for ${version} are unavailable.` };
  };
  if (options.allowSync === false && !force) return useFallback(new Error("synchronization disabled during startup"));

  mkdirSync(cacheRoot, { recursive: true });
  const temporary = mkdtempSync(join(cacheRoot, ".sync-"));
  try {
    const names = skillNames(JSON.parse(await runCli(["skills", "list", "--json"], env)) as unknown);
    for (const name of names) {
      assertSkillName(name);
      const directory = join(temporary, name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "SKILL.md"), await runCli(["skills", "read", name], env));
      await exportEmbeddedFiles(name, directory, env);
    }
    if (loadSkillsFromDir({ dir: temporary, source: "lark-cli-official" }).skills.length !== names.length) throw new Error("Official Skill export validation failed.");
    writeFileSync(join(temporary, ".success"), version);
    rmSync(cacheDir, { recursive: true, force: true });
    renameSync(temporary, cacheDir);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    return useFallback(error);
  }
  return { version, cacheDir, skills: loadSkillsFromDir({ dir: cacheDir, source: "lark-cli-official" }).skills, source: "current" };
}
