import { mkdirSync, existsSync, lstatSync, readlinkSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

export function packageManager(agentHome: string, projectRoot: string, projectKey: string) {
  const realProjectDir = join(projectRoot, ".feishu-agent");
  const compatCwd = join(agentHome, ".compat", "projects", projectKey);
  const link = join(compatCwd, ".pi");
  mkdirSync(realProjectDir, { recursive: true });
  mkdirSync(dirname(link), { recursive: true });
  if (!existsSync(link)) {
    try { symlinkSync(realProjectDir, link, "dir"); }
    catch (error) { throw new Error(`Project Feishu Package storage requires symlink support: ${error instanceof Error ? error.message : String(error)}`); }
  } else if (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== realProjectDir) throw new Error(`Refusing incompatible project package mapping: ${link}`);
  const settings = SettingsManager.create(compatCwd, agentHome, { projectTrusted: true });
  return new DefaultPackageManager({ cwd: compatCwd, agentDir: agentHome, settingsManager: settings });
}
