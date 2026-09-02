import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { projectKeyFor } from "./policy.js";
export { projectKeyFor } from "./policy.js";

export interface SessionSelection {
  manager: SessionManager;
  originalCwd?: string;
}

export function sessionDirectory(agentHome: string, projectRoot: string): string {
  const dir = join(agentHome, "sessions", projectKeyFor(projectRoot));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function sessionManagerFor(agentHome: string, projectRoot: string, launchCwd: string, resume: boolean, sessionId?: string): Promise<SessionSelection> {
  const sessionDir = sessionDirectory(agentHome, projectRoot);
  if (sessionId) {
    const selected = (await SessionManager.listAll(sessionDir)).find((session) => session.id === sessionId || session.id.startsWith(sessionId));
    if (!selected) throw new Error(`No Feishu session found matching '${sessionId}' in this project.`);
    return { manager: SessionManager.open(selected.path, dirname(selected.path), launchCwd), originalCwd: selected.cwd || undefined };
  }
  if (!resume) return { manager: SessionManager.create(launchCwd, sessionDir) };
  const recent = (await SessionManager.listAll(sessionDir)).sort((a, b) => b.modified.getTime() - a.modified.getTime() || b.created.getTime() - a.created.getTime())[0];
  if (!recent) return { manager: SessionManager.create(launchCwd, sessionDir) };
  return { manager: SessionManager.open(recent.path, dirname(recent.path), launchCwd), originalCwd: recent.cwd || undefined };
}

export function cwdMismatchNotice(originalCwd: string | undefined, launchCwd: string): string | undefined {
  return originalCwd && originalCwd !== launchCwd ? `Resumed session created in ${originalCwd}; runtime CWD is ${launchCwd}.` : undefined;
}
