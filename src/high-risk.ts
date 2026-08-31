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
