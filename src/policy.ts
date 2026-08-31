import { createHash } from "node:crypto";
import { basename } from "node:path";

export const CORE_TOOLS = ["read", "edit", "write", "bash", "grep", "find", "ls"] as const;

export function projectKeyFor(projectRoot: string): string {
  const slug = basename(projectRoot).replace(/[^a-zA-Z0-9._-]+/g, "-") || "project";
  return `${slug}-${createHash("sha256").update(projectRoot).digest("hex").slice(0, 12)}`;
}
