export interface LarkApproval {
  action: string;
  target: string;
  identity: "user" | "bot";
  scope: string;
  consumed: boolean;
}

const NATURAL_APPROVAL = /^(?:please\s+)?(delete|remove|revoke|withdraw)\s+(?:the\s+)?(.+?)\s+as\s+(?:the\s+)?(user|bot)\s+(?:for|within|in)\s+(.+?)[.!]?$/i;
const HIGH_RISK_ACTIONS = new Set(["delete", "remove", "revoke", "withdraw"]);
const TARGET_FLAGS = ["--id", "--target", "--resource", "--message-id", "--doc-id"];
const POLICY_BOUNDARY = "This Feishu Runtime policy guard is not an OS security boundary.";

function shellWords(command: string): string[] | undefined {
  if (/[\n\r;&|<>`$\\#*?\[\]{}~()]|&&|\|\|/.test(command)) return undefined;
  const words = command.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  return words?.map((word) => word.replace(/^(?:"|')|(?:"|')$/g, ""));
}

function isLarkCli(word: string): boolean {
  return /(?:^|\/)lark-cli$/.test(word);
}

function larkWords(words: string[]): string[] | undefined {
  const index = words.findIndex(isLarkCli);
  if (index < 0) return undefined;
  if (index === 0 || words.slice(0, index).every((word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word))) return words.slice(index);
  if (/(?:^|\/)env$/.test(words[0]) && words.slice(1, index).every((word) => word.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word))) return words.slice(index);
  return undefined;
}

function recognizableHighRiskLark(command: string): boolean {
  return /(?:^|[\s;&|()])(?:[^\s;&|()]*\/)?lark-cli(?=\s|$)[\s\S]*?\b(?:delete|remove|revoke|withdraw)\b/i.test(command);
}

function optionValues(words: string[], flags: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < words.length; index++) {
    const flag = flags.find((candidate) => words[index] === candidate || words[index].startsWith(`${candidate}=`));
    if (!flag) continue;
    values.push(words[index] === flag ? words[index + 1] ?? "" : words[index].slice(flag.length + 1));
  }
  return values;
}

export function extractLarkOperation(command: string): Omit<LarkApproval, "consumed"> | undefined {
  const words = shellWords(command);
  const lark = words && larkWords(words);
  if (!lark) return undefined;
  const actions = lark.filter((word) => HIGH_RISK_ACTIONS.has(word.toLowerCase()));
  const identities = optionValues(lark, ["--as"]);
  const targets = optionValues(lark, TARGET_FLAGS);
  const scopes = optionValues(lark, ["--scope"]);
  if (actions.length !== 1 || targets.length !== 1 || identities.length !== 1 || scopes.length !== 1) return undefined;
  if (!targets[0] || targets[0].startsWith("-") || !["user", "bot"].includes(identities[0]) || !scopes[0] || scopes[0].startsWith("-")) return undefined;
  return { action: actions[0].toLowerCase(), target: targets[0], identity: identities[0] as "user" | "bot", scope: scopes[0] };
}

export function approvalFromExactRequest(request?: string): LarkApproval | undefined {
  const match = request?.trim().match(NATURAL_APPROVAL);
  if (!match) return undefined;
  return {
    action: match[1].toLowerCase(),
    target: match[2].trim(),
    identity: match[3].toLowerCase() as "user" | "bot",
    scope: match[4].trim(),
    consumed: false,
  };
}

export function authorizeLarkCommand(command: string, approval?: LarkApproval, nonInteractive = false): void {
  const words = shellWords(command);
  if (!words) {
    if (recognizableHighRiskLark(command) && (nonInteractive || /(?:^|\s)--yes(?:\s|$)/.test(command))) {
      throw new Error(`Blocked chained or ambiguous high-risk lark-cli command: exact one-shot approval is required and Print mode cannot prompt. ${POLICY_BOUNDARY}`);
    }
    return;
  }
  const lark = larkWords(words);
  if (!lark) {
    if (recognizableHighRiskLark(command) && (nonInteractive || words.some((word) => word === "--yes" || word.startsWith("--yes=")))) {
      throw new Error(`Blocked wrapped or ambiguous high-risk lark-cli command: exact one-shot approval is required and Print mode cannot prompt. ${POLICY_BOUNDARY}`);
    }
    return;
  }
  if (!lark.some((word) => HIGH_RISK_ACTIONS.has(word.toLowerCase()))) return;
  const hasYes = lark.some((word) => word === "--yes" || word.startsWith("--yes="));
  if (nonInteractive && !hasYes) throw new Error(`High-risk Approval required: Print mode cannot prompt for this lark-cli write. ${POLICY_BOUNDARY}`);
  if (!hasYes) return;
  const operation = extractLarkOperation(command);
  if (!operation || !approval || approval.consumed || approval.action !== operation.action || approval.target !== operation.target || approval.identity !== operation.identity || approval.scope !== operation.scope) {
    throw new Error(`Blocked lark-cli --yes: exact one-shot approval for this action, target, identity, and scope is required. Print mode cannot prompt. ${POLICY_BOUNDARY}`);
  }
  approval.consumed = true;
}
