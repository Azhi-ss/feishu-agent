import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REMOTE_PACKAGE_NAME = "@azhi-ss/feishu-remote";

export function feishuRemotePackagePath(): string {
  const candidate = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "feishu-remote");
  if (!existsSync(join(candidate, "package.json"))) throw new Error("Feishu Remote Package is missing from this installation.");
  return realpathSync(candidate);
}

function packageNameAt(dir: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string }).name;
  } catch {
    return undefined;
  }
}

export function isRemoteNpmSource(source: string): boolean {
  const normalized = source.replace(/\\/g, "/");
  return normalized === REMOTE_PACKAGE_NAME
    || normalized === `npm:${REMOTE_PACKAGE_NAME}`
    || normalized.startsWith(`npm:${REMOTE_PACKAGE_NAME}@`);
}

export function isRemotePackageConfigured(entry: { source: string; installedPath?: string }, agentHome: string): boolean {
  if (isRemoteNpmSource(entry.source)) return true;
  for (const raw of [entry.installedPath, entry.source]) {
    if (!raw || raw.startsWith("npm:")) continue;
    const resolved = isAbsolute(raw) ? raw : join(agentHome, raw);
    if (packageNameAt(resolved) === REMOTE_PACKAGE_NAME) return true;
  }
  return false;
}

export function isAllowlistedRemoteExtension(extensionPath: string): boolean {
  let dir = dirname(extensionPath);
  for (let i = 0; i < 8; i++) {
    const name = packageNameAt(dir);
    if (name) return name === REMOTE_PACKAGE_NAME;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}
