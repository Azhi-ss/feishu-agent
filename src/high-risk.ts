import { execFileSync } from "node:child_process";

export interface LarkApproval {
  action: string;
  target: string;
  identity: "user" | "bot";
  scope: string;
  consumed: boolean;
}

interface LarkCommandMetadata {
  risk: string;
  action: string;
  target: string;
  identity: string;
  scope: string;
}

const ENGLISH_APPROVAL = /^(?:please\s+)?(delete|remove|revoke|withdraw)\s+(?:the\s+)?(.+?)\s+as\s+(?:the\s+)?(user|bot)\s+(?:for|within|in)\s+(.+?)[.!]?$/i;
const CHINESE_APPROVAL = /^(?:请)?(?:以)?(用户|机器人)(?:身份)?(?:在|于)(.+?)(?:范围内)?(删除|移除|撤销|撤回)(.+?)[。！]?$/;
const CHINESE_ACTIONS: Record<string, string> = { 删除: "delete", 移除: "remove", 撤销: "revoke", 撤回: "withdraw" };
const POLICY_BOUNDARY = "This Feishu Runtime policy guard is not an OS security boundary.";

function shellWords(command: string): string[] | undefined {
  if (/[\n\r;&|<>`$\\#*?\[\]{}~()]|&&|\|\|/.test(command)) return undefined;
  const words = command.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  return words?.map((word) => word.replace(/^(?:"|')|(?:"|')$/g, ""));
}

function isLarkCli(word: string): boolean { return /(?:^|\/)lark-cli$/.test(word); }

function larkWords(words: string[]): string[] | undefined {
  const index = words.findIndex(isLarkCli);
  if (index < 0) return undefined;
  if (index === 0 || words.slice(0, index).every((word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word))) return words.slice(index);
  if (/(?:^|\/)env$/.test(words[0]) && words.slice(1, index).every((word) => word.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word))) return words.slice(index);
  return undefined;
}

function parseMetadata(help: string, commandPath: string[] = []): LarkCommandMetadata | undefined {
  const fields = Object.fromEntries(help.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(Risk|Action|Target|Identity|Scope)\s*:\s*(.+?)\s*$/i);
    return match ? [[match[1].toLowerCase(), match[2]]] : [];
  })) as Partial<LarkCommandMetadata>;
  if (!fields.risk) return undefined;
  fields.risk = fields.risk.split(/\s|\(/, 1)[0];
  fields.action ??= commandPath.at(-1)?.replace(/^\+/, "");
  fields.identity ??= /--as\s+string\b/.test(help) ? "--as" : undefined;
  if (!fields.target) {
    const required = help.match(/Required:\s*([\s\S]*?)(?:\n\s*(?:Optional:|Raw Parameter Input:|Execution:|Output:|Other:)|$)/)?.[1];
    const targetFlags = [...(required ?? help).matchAll(/^\s*(--[\w-]+)\s+string\b/gm)].map((match) => match[1])
      .filter((flag) => /(?:^|-)id$|(?:^|-)token$/.test(flag));
    fields.target = targetFlags[0];
  }
  fields.scope ??= commandPath.join(".");
  return fields.action && fields.target && fields.identity && fields.scope ? fields as LarkCommandMetadata : undefined;
}

function defaultMetadataResolver(lark: string[]): LarkCommandMetadata | undefined {
  const path: string[] = [];
  for (let index = 1; index < lark.length; index++) {
    const word = lark[index];
    if (word.startsWith("-")) break;
    path.push(word);
    if (path.length === 3 || path.length >= 2 && path.at(-1)?.startsWith("+")) break;
  }
  const lengths = [...new Set([Math.min(2, path.length), path.length, 1])];
  for (const length of lengths) {
    if (length < 1) continue;
    const candidate = path.slice(0, length);
    try {
      const metadata = parseMetadata(execFileSync(lark[0], [...candidate, "--help"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }), candidate);
      if (metadata?.risk.toLowerCase() === "high-risk-write") return metadata;
    } catch {}
  }
  return undefined;
}

function values(words: string[], selector: string): string[] {
  if (selector.startsWith("positional:")) {
    const wanted = Number(selector.slice(11));
    const positional: string[] = [];
    for (let index = 3; index < words.length; index++) {
      const word = words[index];
      if (word.startsWith("-")) { if (!word.includes("=") && words[index + 1] && !words[index + 1].startsWith("-")) index++; continue; }
      positional.push(word);
    }
    return positional.length === wanted + 1 ? [positional[wanted]] : [];
  }
  const found: string[] = [];
  for (let index = 0; index < words.length; index++) {
    if (words[index] === selector) found.push(words[index + 1] ?? "");
    else if (words[index].startsWith(`${selector}=`)) found.push(words[index].slice(selector.length + 1));
  }
  return found;
}

export function extractLarkOperation(command: string, resolveMetadata: (lark: string[]) => LarkCommandMetadata | undefined = defaultMetadataResolver): Omit<LarkApproval, "consumed"> | undefined {
  const words = shellWords(command);
  const lark = words && larkWords(words);
  if (!lark) return undefined;
  const metadata = resolveMetadata(lark);
  if (!metadata || metadata.risk.toLowerCase() !== "high-risk-write") return undefined;
  const targets = values(lark, metadata.target);
  const identities = values(lark, metadata.identity);
  if (targets.length !== 1 || identities.length !== 1 || !targets[0] || !["user", "bot"].includes(identities[0])) return undefined;
  return { action: metadata.action.toLowerCase(), target: targets[0], identity: identities[0] as "user" | "bot", scope: metadata.scope };
}

function normalizeScope(scope: string): string {
  return scope.trim().replace(/[.!。！]+$/, "");
}

export function approvalFromExactRequest(request?: string): LarkApproval | undefined {
  const text = request?.trim();
  if (!text) return undefined;
  const english = text.match(ENGLISH_APPROVAL);
  if (english) return { action: english[1].toLowerCase(), target: english[2].trim(), identity: english[3].toLowerCase() as "user" | "bot", scope: normalizeScope(english[4]), consumed: false };
  const chinese = text.match(CHINESE_APPROVAL);
  if (chinese) return { action: CHINESE_ACTIONS[chinese[3]], target: chinese[4].trim(), identity: chinese[1] === "用户" ? "user" : "bot", scope: chinese[2].trim(), consumed: false };
  return undefined;
}

export function authorizeLarkCommand(command: string, approval?: LarkApproval, nonInteractive = false, resolveMetadata: (lark: string[]) => LarkCommandMetadata | undefined = defaultMetadataResolver): void {
  const words = shellWords(command);
  const hasYes = /(?:^|\s)--yes(?:\s|$|=)/.test(command);
  if (!words) {
    if (hasYes || (nonInteractive && /(?:^|[\s;&|()])(?:[^\s;&|()]*\/)?lark-cli(?=\s|$)[\s\S]*?\b(?:delete|remove|revoke|withdraw)\b/i.test(command))) throw new Error(`Blocked chained or ambiguous high-risk lark-cli command: exact one-shot approval is required and Print mode cannot prompt. ${POLICY_BOUNDARY}`);
    return;
  }
  const lark = larkWords(words);
  if (!lark) return;
  const metadata = resolveMetadata(lark);
  const highRisk = metadata?.risk.toLowerCase() === "high-risk-write";
  const operation = highRisk ? extractLarkOperation(command, () => metadata) : undefined;
  if (!operation) {
    if (hasYes || (nonInteractive && highRisk)) throw new Error(`Blocked lark-cli command: auditable high-risk command metadata and exact parameters are required; Print mode cannot prompt. ${POLICY_BOUNDARY}`);
    return;
  }
  if (nonInteractive && !hasYes) throw new Error(`High-risk Approval required: Print mode cannot prompt for this lark-cli write. ${POLICY_BOUNDARY}`);
  if (!hasYes) return;
  if (!approval || approval.consumed || approval.action !== operation.action || approval.target !== operation.target || approval.identity !== operation.identity || approval.scope !== operation.scope) {
    throw new Error(`Blocked lark-cli --yes: exact one-shot approval for this action, target, identity, and scope is required. Print mode cannot prompt. ${POLICY_BOUNDARY}`);
  }
  approval.consumed = true;
}
