import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const CLI_TIMEOUT_MS = 1500;

function safeVersion(version: string): string {
  return Buffer.from(version).toString("base64url");
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

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const result = await execFileAsync("lark-cli", args, {
    encoding: "utf8",
    env,
    timeout: CLI_TIMEOUT_MS,
    killSignal: "SIGTERM",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout;
}

export async function syncOfficialSkills(
  cacheRoot: string,
  force = false,
  env = process.env,
  options: OfficialSkillsOptions = {},
): Promise<OfficialSkillsResult> {
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
      const directory = join(temporary, basename(name));
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "SKILL.md"), await runCli(["skills", "read", name], env));
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
