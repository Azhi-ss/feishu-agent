import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { CustomEditor, SessionSelectorComponent } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { prohibitedCommand } from "./command-policy.js";
import { authorizeLarkCommand, approvalFromExactRequest, type LarkApproval } from "./high-risk.js";

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

export function corePolicyExtension(currentRequest?: string, switchSelectedSession?: (path: string) => Promise<void>, memoryDiagnostic?: () => string | undefined): ExtensionFactory {
  let approval: LarkApproval | undefined = approvalFromExactRequest(currentRequest);
  return (pi: ExtensionAPI) => {
    pi.on("session_start", (_event, ctx) => {
      installOuterEditorGuard(ctx);
      if (ctx.mode === "tui") {
        const warning = memoryDiagnostic?.();
        if (warning) ctx.ui.notify(warning, "warning");
      }
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
      approval = approvalFromExactRequest(event.text);
    });
    pi.on("tool_call", (event, ctx) => {
      if (event.toolName !== "bash") return;
      try { authorizeLarkCommand(String(event.input.command ?? ""), approval, ctx.mode === "print"); }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (ctx.mode === "tui") ctx.ui.notify(reason, "error");
        return { block: true, terminate: ctx.mode === "print", reason };
      }
    });
  };
}
