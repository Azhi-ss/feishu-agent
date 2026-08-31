import { mkdirSync, existsSync, lstatSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";

let compatibilityHomeBusy = false;

export function ensureCompatibilityHome(realHome: string, agentHome: string): string {
  const home = join(agentHome, ".compat", "home");
  const link = join(home, ".pi", "agent");
  mkdirSync(join(home, ".pi"), { recursive: true });
  if (!existsSync(link)) symlinkSync(agentHome, link, "dir");
  else if (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== agentHome) throw new Error(`Invalid compatibility Home mapping: ${link}`);
  return home;
}

export async function withCompatibilityHome<T>(realHome: string, agentHome: string, work: () => Promise<T>): Promise<T> {
  if (compatibilityHomeBusy) throw new Error("Compatibility Home initialization is already active.");
  compatibilityHomeBusy = true;
  const previous = process.env.HOME;
  process.env.HOME = ensureCompatibilityHome(realHome, agentHome);
  try { return await work(); }
  finally { process.env.HOME = previous ?? realHome; compatibilityHomeBusy = false; }
}
