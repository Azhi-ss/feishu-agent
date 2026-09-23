import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { AutomationError } from "./automation.js";

export function executable(name: string): string {
  const candidates = name.includes("/") ? [resolve(name)] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(dir => resolve(dir, name));
  for (const path of candidates) {
    try { accessSync(path, constants.X_OK); } catch { continue; }
    if (lstatSync(realpathSync(path)).isFile()) return path;
  }
  throw new AutomationError(`Required executable ${name} is unavailable. Fix PATH and retry.`);
}
