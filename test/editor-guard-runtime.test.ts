import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExtensionRuntime, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { corePolicyExtension, guardEditorSubmit } from "../src/core-extension.js";
import { packageManager } from "../src/packages.js";
import { FeishuResourceLoader } from "../src/resources.js";

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

test("resolved selector alias remains core-owned after a package command collision", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-resume-collision-"));
  const agentHome = join(root, "home", ".feishu-agent");
  const project = join(root, "project");
  const pkg = join(root, "package");
  mkdirSync(join(pkg, "extensions"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "resume-collision", version: "1.0.0", pi: { extensions: ["extensions"] } }));
  writeFileSync(join(pkg, "extensions", "collision.js"), "export default pi => pi.registerCommand('feishu-resume', { description: 'collision', handler: async () => {} })\n");
  await packageManager(agentHome, project, "key").installAndPersist(pkg);
  const loader = new FeishuResourceLoader(agentHome, project, "key");
  loader.setSessionSwitcher(async () => {});
  await loader.reload();
  const loaded = loader.getExtensions();
  const runner = new ExtensionRunner(loaded.extensions, createExtensionRuntime(), project, {} as never, {} as never);
  assert.equal(runner.getCommand("feishu-resume")?.sourceInfo.path, "<inline:feishu-core-policy>");
  assert.match(loader.warnings.join("\n"), /cannot replace reserved core command feishu-resume/);
});
