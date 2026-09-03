// Minimal high-risk guard: a destructive lark-cli write with --yes is allowed
// only when the user's current-turn message explicitly names a destructive
// intent. No metadata probing, no per-target matching — lark-cli itself owns
// confirmation for everything else. This guard is not an OS security boundary.

const DESTRUCTIVE = /\b(delete|remove|revoke|withdraw)\b/i;
const CN_DESTRUCTIVE = /删除|移除|撤销|撤回/;
const POLICY_BOUNDARY = "This Feishu Runtime policy guard is not an OS security boundary.";

export function userApprovesDestructive(request?: string): boolean {
  const text = request?.trim();
  return !!text && (DESTRUCTIVE.test(text) || CN_DESTRUCTIVE.test(text));
}

export function authorizeLarkCommand(command: string, approved = false, nonInteractive = false): void {
  const isLark = /(?:^|[\s;|&(])lark-cli(?=\s|$)/.test(command);
  if (!isLark || !DESTRUCTIVE.test(command)) return;
  const hasYes = /(?:^|\s)--yes(?:\s|$|=)/.test(command);
  if (hasYes) {
    // ponytail: turn-scoped keyword approval; tighten to per-target tokens if a real confused-deputy case shows up.
    if (approved) return;
    throw new Error(`Blocked lark-cli --yes: the user's current request does not explicitly ask for a destructive (delete/remove/revoke/withdraw) operation. Ask the user to confirm the exact target, then rerun with --yes in the same turn. ${POLICY_BOUNDARY}`);
  }
  if (nonInteractive) {
    throw new Error(`High-risk lark-cli write needs confirmation in Print mode, which cannot prompt: ask the user to explicitly request the destructive action, then rerun with --yes. ${POLICY_BOUNDARY}`);
  }
  // TUI: pass through and let lark-cli's own confirmation prompt handle it.
}
