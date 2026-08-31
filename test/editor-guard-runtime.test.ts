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

test("resume startup extension registers a host-owned current-project selector command", () => {
  const commands: string[] = [];
  corePolicyExtension(undefined, true)({
    on: () => {},
    registerCommand: (name: string) => commands.push(name),
  } as never);
  assert.deepEqual(commands, ["feishu-resume"]);
});
