export interface LarkApproval {
  command: string;
  consumed: boolean;
}

const EXACT_REQUEST = /^(?:please\s+)?(?:run|execute)\s+(.+)$/is;

export function canonicalLarkCommand(command: string): string | undefined {
  const segment = command.trim();
  if (!/(?:^|[;&|]\s*)lark-cli(?:\s|$)/.test(segment) || !/(?:^|\s)--yes(?:\s|$)/.test(segment)) return undefined;
  if (/\n|\r|&&|\|\||;/.test(segment)) return undefined;
  return segment.replace(/\s+/g, " ");
}

export function approvalFromExactRequest(request?: string): LarkApproval | undefined {
  const match = request?.trim().match(EXACT_REQUEST);
  const command = match && canonicalLarkCommand(match[1]);
  return command ? { command, consumed: false } : undefined;
}

export function authorizeLarkCommand(command: string, approval?: LarkApproval): void {
  const exact = canonicalLarkCommand(command);
  if (!exact) return;
  if (!approval || approval.consumed || approval.command !== exact) {
    throw new Error("Blocked lark-cli --yes: exact one-shot approval for this command is required. Print mode cannot prompt. This guard is not an OS security boundary.");
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
