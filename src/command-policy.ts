export const PROHIBITED_COMMANDS: Record<string, string> = {
  share: "Feishu Agent does not share sessions.",
  import: "Feishu Agent does not import external sessions.",
  login: "Manage model credentials with ordinary Pi.",
  logout: "Manage model credentials with ordinary Pi.",
};

export function prohibitedCommand(input: string): string | undefined {
  const match = /^\/(share|import|login|logout)(?:\s|$)/.exec(input.trim());
  return match ? PROHIBITED_COMMANDS[match[1]] : undefined;
}
