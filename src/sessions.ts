import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export function projectKeyFor(projectRoot: string): string {
  const slug = basename(projectRoot).replace(/[^a-zA-Z0-9._-]+/g, "-") || "project";
  return `${slug}-${createHash("sha256").update(projectRoot).digest("hex").slice(0, 12)}`;
}

export function sessionManagerFor(agentHome: string, projectRoot: string, launchCwd: string, resume: boolean) {
  const sessionDir = join(agentHome, "sessions", projectKeyFor(projectRoot));
  mkdirSync(sessionDir, { recursive: true });
  return resume ? SessionManager.continueRecent(launchCwd, sessionDir) : SessionManager.create(launchCwd, sessionDir);
}
