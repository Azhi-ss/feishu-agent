import assert from "node:assert/strict";
import test from "node:test";
import { corePolicyExtension, guardEditorSubmit } from "../src/core-extension.js";

class FakeEditor {
  onSubmit?: (text: string) => void;
}

test("outer editor guard intercepts Pi-wired submit after custom editor creation", () => {
  const editor = new FakeEditor();
  const forwarded: string[] = [];
  const feedback: string[] = [];
  guardEditorSubmit(editor, (message) => feedback.push(message));
  editor.onSubmit = (text) => forwarded.push(text);
  editor.onSubmit?.("/share now");
  editor.onSubmit?.("please mention /share");
  assert.deepEqual(forwarded, ["please mention /share"]);
  assert.match(feedback[0], /does not share sessions/);
});

test("core tool_call hook enforces exact one-shot lark approval and Print termination", async () => {
  const handlers = new Map<string, Function>();
  const command = "lark-cli doc delete --id doc-1 --as user --scope one-document --yes";
  corePolicyExtension("delete doc-1 as user for one-document")({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: () => {},
  } as never);
  const hook = handlers.get("tool_call")!;
  assert.equal(await hook({ toolName: "bash", input: { command } }, { mode: "print", ui: { notify: () => {} } }), undefined);
  const blocked = await hook({ toolName: "bash", input: { command } }, { mode: "print", ui: { notify: () => {} } });
  assert.deepEqual({ block: blocked.block, terminate: blocked.terminate }, { block: true, terminate: true });
});
test("resume startup extension registers a host-owned current-project selector command", () => {
  const commands: string[] = [];
  corePolicyExtension(undefined, async () => {})({
    on: () => {},
    registerCommand: (name: string) => commands.push(name),
  } as never);
  assert.deepEqual(commands, ["feishu-resume"]);
});
