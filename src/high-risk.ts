export interface LarkApproval {
  action: string;
  target: string;
  identity: "user" | "bot";
  scope: string;
  consumed: boolean;
}

const NATURAL_APPROVAL = /^(?:please\s+)?(delete|remove|revoke|withdraw)\s+(?:the\s+)?(.+?)\s+as\s+(?:the\s+)?(user|bot)(?:\s+(?:for|within|in)\s+(.+?))?[.!]?$/i;
const HIGH_RISK_ACTIONS = new Set(["delete", "remove", "revoke", "withdraw"]);

function shellWords(command: string): string[] | undefined {
  if (/\n|\r|&&|\|\||;|`|\$\(/.test(command)) return undefined;
  const words = command.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  return words?.map((word) => word.replace(/^(?:"|')|(?:"|')$/g, ""));
}

export function extractLarkOperation(command: string): Omit<LarkApproval, "consumed"> | undefined {
  const words = shellWords(command);
  if (!words || words[0] !== "lark-cli") return undefined;
  const actionIndex = words.findIndex((word) => HIGH_RISK_ACTIONS.has(word.toLowerCase()));
  const identityIndex = words.findIndex((word) => word === "--as");
  if (actionIndex < 1 || identityIndex < 0 || !["user", "bot"].includes(words[identityIndex + 1])) return undefined;
  const targetFlags = ["--id", "--target", "--resource", "--message-id", "--doc-id"];
  const targetIndex = words.findIndex((word) => targetFlags.includes(word));
  const target = targetIndex >= 0 ? words[targetIndex + 1] : words[actionIndex + 1];
  if (!target || target.startsWith("-")) return undefined;
  const scopeIndex = words.findIndex((word) => word === "--scope");
  return {
    action: words[actionIndex].toLowerCase(),
    target,
    identity: words[identityIndex + 1] as "user" | "bot",
    scope: scopeIndex >= 0 && words[scopeIndex + 1] ? words[scopeIndex + 1] : "one resource",
  };
}

export function approvalFromExactRequest(request?: string): LarkApproval | undefined {
  const match = request?.trim().match(NATURAL_APPROVAL);
  if (!match) return undefined;
  return {
    action: match[1].toLowerCase(),
    target: match[2].trim(),
    identity: match[3].toLowerCase() as "user" | "bot",
    scope: match[4]?.trim() || "one resource",
    consumed: false,
  };
}

export function authorizeLarkCommand(command: string, approval?: LarkApproval): void {
  const words = shellWords(command);
  if (!words) {
    if (/lark-cli[\s\S]*--yes/.test(command)) throw new Error("Blocked chained or ambiguous lark-cli --yes command: exact one-shot approval is required. Print mode cannot prompt. This guard is not an OS security boundary.");
    return;
  }
  if (words[0] !== "lark-cli" || !words.includes("--yes")) return;
  const operation = extractLarkOperation(command);
  if (!operation || !approval || approval.consumed || approval.action !== operation.action || approval.target !== operation.target || approval.identity !== operation.identity || approval.scope !== operation.scope) {
    throw new Error("Blocked lark-cli --yes: exact one-shot approval for this action, target, identity, and scope is required. Print mode cannot prompt. This guard is not an OS security boundary.");
  }
  approval.consumed = true;
}

export interface HighRiskApproval {
  action: string;
  target: string;
  identity: "user" | "bot";
  scope: string;
  consumed: boolean;
}

export function approveHighRisk(action: string, target: string, identity: "user" | "bot", scope: string): HighRiskApproval {
  if (![action, target, scope].every((value) => value.trim())) throw new Error("High-risk Approval requires exact action, target, identity, and scope.");
  return { action, target, identity, scope, consumed: false };
}

export function authorizeHighRisk(approval: HighRiskApproval | undefined, operation: Omit<HighRiskApproval, "consumed">): void {
  if (!approval || approval.consumed || approval.action !== operation.action || approval.target !== operation.target || approval.identity !== operation.identity || approval.scope !== operation.scope) {
    throw new Error("High-risk Approval required: operation does not exactly match the current action, target, identity, and scope. This Feishu Runtime guard is not an OS security boundary.");
  }
  approval.consumed = true;
}
