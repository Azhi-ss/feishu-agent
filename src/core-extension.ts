import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { CustomEditor, SessionSelectorComponent } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { authorizeLarkCommand, userApprovesDestructive } from "./high-risk.js";
import { setMemoryStatus, setSkillsStatus, type SkillsStatus } from "./tui-status.js";

const PROHIBITED_COMMANDS: Record<string, string> = {
  share: "Feishu Agent does not share sessions.",
  import: "Feishu Agent does not import external sessions.",
  login: "Manage model credentials with ordinary Pi.",
  logout: "Manage model credentials with ordinary Pi.",
};

export function prohibitedCommand(input: string): string | undefined {
  const match = /^\/(share|import|login|logout)(?:\s|$)/.exec(input.trim());
  return match ? PROHIBITED_COMMANDS[match[1]] : undefined;
}

interface EditorLike {
  onSubmit?: (text: string) => void;
}

export function guardEditorSubmit(editor: EditorLike, feedback: (message: string) => void): void {
  let submit = editor.onSubmit;
  Object.defineProperty(editor, "onSubmit", {
    configurable: true,
    get: () => submit,
    set: (next: ((text: string) => void) | undefined) => {
      submit = next && ((text: string) => {
        const reason = prohibitedCommand(text);
        if (reason) feedback(reason);
        else next(text === "/resume" ? "/feishu-resume" : text);
      });
    },
  });
  if (submit) editor.onSubmit = submit;
}

export function installOuterEditorGuard(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  const inner = ctx.ui.getEditorComponent();
  ctx.ui.setEditorComponent((tui, theme, keybindings) => {
    const editor = inner ? inner(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
    guardEditorSubmit(editor, (message) => ctx.ui.notify(message, "error"));
    return editor;
  });
}

function installStatusLine(pi: ExtensionAPI, skillsStatus?: () => SkillsStatus, memoryOn?: () => boolean): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    setMemoryStatus(ctx, memoryOn?.() ?? false);
    setSkillsStatus(ctx, skillsStatus?.() ?? "unavailable");
  });
}

export function corePolicyExtension(currentRequest?: string, switchSelectedSession?: (path: string) => Promise<void>, resourceLoader?: { getSystemPrompt(): string | undefined; getSkillsStatus?: () => SkillsStatus; getMemoryStatus?: () => "on" | "off"; setDestructiveApproval?: (approved: boolean) => void }): ExtensionFactory {
  let approved = userApprovesDestructive(currentRequest);
  return (pi: ExtensionAPI) => {
    installStatusLine(pi, resourceLoader?.getSkillsStatus?.bind(resourceLoader), () => resourceLoader?.getMemoryStatus?.() === "on");
    pi.on("session_start", (_event, ctx) => {
      installOuterEditorGuard(ctx);
    });
    if (switchSelectedSession) pi.registerCommand("feishu-resume", {
      description: "Open the current Feishu Project session selector",
      handler: async (_args, ctx) => {
        await ctx.ui.custom((tui, _theme, keybindings, done) => new SessionSelectorComponent(
          (onProgress) => SessionManager.listAll(ctx.sessionManager.getSessionDir(), onProgress),
          (onProgress) => SessionManager.listAll(ctx.sessionManager.getSessionDir(), onProgress),
          async (path) => { done(undefined); await switchSelectedSession(path); },
          () => done(undefined),
          () => ctx.shutdown(),
          () => tui.requestRender(),
          { keybindings },
          ctx.sessionManager.getSessionFile(),
        ));
      },
    });
    pi.on("input", (event) => {
      const reason = prohibitedCommand(event.text);
      if (reason) return { action: "handled" as const };
      approved = userApprovesDestructive(event.text);
      resourceLoader?.setDestructiveApproval?.(approved);
    });
    if (resourceLoader) pi.on("before_agent_start", (event) => {
      const base = resourceLoader.getSystemPrompt() ?? event.systemPrompt ?? "";
      return { systemPrompt: event.systemPrompt?.startsWith(base) ? event.systemPrompt : `${base}\n\n${event.systemPrompt ?? ""}` };
    });
    pi.on("tool_call", (event, ctx) => {
      if (event.toolName !== "bash") return;
      try { authorizeLarkCommand(String(event.input.command ?? ""), approved, ctx.mode === "print"); }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (ctx.mode === "tui") ctx.ui.notify(reason, "error");
        return { block: true, terminate: ctx.mode === "print", reason };
      }
    });
  };
}

export const ASK_USER_TOOL = "ask_user";

export function askUserExtension(): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("tool_call", (event, ctx) => {
      if (event.toolName === ASK_USER_TOOL || !currentReplyAsksUser(ctx)) return;
      return { block: true, terminate: true, reason: "ask_user ends this run. This tool was not executed; wait for the user's answer." };
    });
    pi.registerTool({
      name: ASK_USER_TOOL,
      label: "Ask user",
      description: "Ask the user one question when a missing detail or an explicit confirmation blocks the task. Call it alone: any other tool in the same response is not executed. This ends the current run; the user's answer arrives as the next message in this session. Do not guess instead of asking.",
      promptSnippet: "Ask one blocking question alone, then end this run",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question, self-contained for someone who has not seen this session." },
          options: { type: "array", items: { type: "string" }, description: "Optional short answer choices." },
        },
        required: ["question"],
        additionalProperties: false,
      },
      execute: async (_toolCallId, params) => ({ content: [{ type: "text", text: "Question delivered to the user; their answer will arrive as the next message." }], details: params, terminate: true }),
    });
  };
}

function currentReplyAsksUser(ctx: ExtensionContext): boolean {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    return entry.message.content.some((part) => part.type === "toolCall" && part.name === ASK_USER_TOOL);
  }
  return false;
}
