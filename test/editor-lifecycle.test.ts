import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { installOuterEditorGuard } from "../src/core-extension.js";

class FakeEditor { onSubmit?: (text: string) => void; setText() {}; getText() { return ""; } }

function uiHarness() {
  let factory: any;
  const notices: string[] = [];
  return {
    notices,
    ui: {
      setEditorComponent: (next: any) => { factory = next; },
      getEditorComponent: () => factory,
      notify: (message: string) => notices.push(message),
    },
    editor: () => factory(null, null, null) as FakeEditor,
  };
}

test("public extension lifecycle keeps the Feishu submit guard outside a third-party CustomEditor across reload", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-editor-life-"));
  const extensionPath = join(root, "custom-editor.js");
  writeFileSync(extensionPath, `export default pi => pi.on("session_start", (_event, ctx) => ctx.ui.setEditorComponent(() => ({ onSubmit: undefined, setText(){}, getText(){ return ""; }, thirdParty: true })))`);
  const loaded = await discoverAndLoadExtensions([extensionPath], root, root, createEventBus());
  const extension = loaded.extensions[0];
  const handler = extension.handlers.get("session_start")![0];
  const authPath = join(root, "auth.json"); writeFileSync(authPath, "AUTH-BYTES");

  for (const lifecycle of ["initial", "reload"]) {
    const harness = uiHarness();
    const ctx = { mode: "tui", ui: harness.ui } as never;
    await handler({ type: "session_start", reason: lifecycle }, ctx);
    installOuterEditorGuard(ctx);
    const editor = harness.editor();
    const forwarded: string[] = [];
    editor.onSubmit = (text) => forwarded.push(text);
    editor.onSubmit("/login provider");
    editor.onSubmit("/logout");
    editor.onSubmit("/export /tmp/session.html");
    editor.onSubmit("/resume");
    assert.deepEqual(forwarded, ["/export /tmp/session.html", "/feishu-resume"]);
    assert.equal(harness.notices.length, 2);
  }
  assert.equal((await import("node:fs")).readFileSync(authPath, "utf8"), "AUTH-BYTES");
});
