import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

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

export function syncOfficialSkills(cacheRoot: string, force = false, env = process.env) {
  const version = execFileSync("lark-cli", ["--version"], { encoding: "utf8", env }).trim();
  const cacheDir = join(cacheRoot, safeVersion(version));
  const marker = join(cacheDir, ".success");
  if (!force && existsSync(marker)) return { version, cacheDir, skills: loadSkillsFromDir({ dir: cacheDir, source: "lark-cli-official" }).skills };

  mkdirSync(cacheRoot, { recursive: true });
  const temporary = mkdtempSync(join(cacheRoot, ".sync-"));
  try {
    const names = skillNames(JSON.parse(execFileSync("lark-cli", ["skills", "list", "--json"], { encoding: "utf8", env })) as unknown);
    for (const name of names) {
      const directory = join(temporary, basename(name));
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "SKILL.md"), execFileSync("lark-cli", ["skills", "read", name], { encoding: "utf8", env }));
    }
    if (loadSkillsFromDir({ dir: temporary, source: "lark-cli-official" }).skills.length !== names.length) throw new Error("Official Skill export validation failed.");
    writeFileSync(join(temporary, ".success"), version);
    rmSync(cacheDir, { recursive: true, force: true });
    renameSync(temporary, cacheDir);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    if (force) throw error;
    const fallback = readdirSync(cacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(cacheRoot, entry.name, ".success")))
      .map((entry) => ({ dir: join(cacheRoot, entry.name), name: entry.name, mtime: statSync(join(cacheRoot, entry.name, ".success")).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))[0]?.dir;
    if (fallback) return { version, cacheDir: fallback, skills: loadSkillsFromDir({ dir: fallback, source: "lark-cli-official" }).skills, warning: `Official Skills for ${version} unavailable; using ${readFileSync(join(fallback, ".success"), "utf8")}.` };
    return { version, cacheDir, skills: [], warning: `Official Skills for ${version} are unavailable.` };
  }
  return { version, cacheDir, skills: loadSkillsFromDir({ dir: cacheDir, source: "lark-cli-official" }).skills };
}
