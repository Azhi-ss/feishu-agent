import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExtensionRuntime, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { corePolicyExtension, guardEditorSubmit } from "../src/core-extension.js";
import { startupBannerExtension } from "../src/startup-banner.js";
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

test("core tool_call hook allows destructive --yes within an approving turn and blocks + terminates otherwise", async () => {
  const handlers = new Map<string, Function>();
  const command = "lark-cli doc delete doc-1 --as user --yes";
  // Guard no longer shells out to lark-cli for metadata; no fake binary on PATH needed.
  corePolicyExtension("delete doc-1 please")({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: () => {},
  } as never);
  const hook = handlers.get("tool_call")!;
  assert.equal(await hook({ toolName: "bash", input: { command } }, { mode: "print", ui: { notify: () => {} } }), undefined);
  // Turn-scoped: a second matching call is still allowed (no one-shot consumption).
  assert.equal(await hook({ toolName: "bash", input: { command } }, { mode: "print", ui: { notify: () => {} } }), undefined);

  const otherHandlers = new Map<string, Function>();
  corePolicyExtension("clean up the documents")({
    on: (name: string, handler: Function) => otherHandlers.set(name, handler),
    registerCommand: () => {},
  } as never);
  const otherHook = otherHandlers.get("tool_call")!;
  const denied = await otherHook({ toolName: "bash", input: { command } }, { mode: "print", ui: { notify: () => {} } });
  assert.deepEqual({ block: denied.block, terminate: denied.terminate }, { block: true, terminate: true });
  assert.match(denied.reason, /Blocked lark-cli --yes/);
});
test("status line chips: model + healthy memory at session start, refreshed on model change; degraded memory warns", async () => {
  const handlerLists = new Map<string, Function[]>();
  const piStub = (name: string, handler: Function) => {
    const list = handlerLists.get(name) ?? [];
    list.push(handler);
    handlerLists.set(name, list);
  };
  const calls: string[] = [];
  const fakeUi = {
    setStatus: (key: string, value: string) => calls.push(`${key}=${value}`),
    theme: { fg: (color: string, text: string) => `[${color}]${text}[/${color}]` },
    notify: () => {},
    getEditorComponent: () => undefined,
    setEditorComponent: () => {},
  };
  const fakeCtx = { mode: "tui", model: { id: "fake-model" }, ui: fakeUi };
  corePolicyExtension(undefined, undefined, () => undefined)({
    on: piStub,
    registerCommand: () => {},
  } as never);
  const root = mkdtempSync(join(tmpdir(), "feishu-status-line-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "lark-cli"), "#!/bin/sh\n[ \"$1 $2\" = \"auth status\" ] && echo '{\"defaultAs\": \"bot\"}' || exit 0\n", { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  await Promise.all(handlerLists.get("session_start")!.map((h) => h({}, fakeCtx)));
  await new Promise((resolve) => setImmediate(resolve));
  process.env.PATH = oldPath;
  const healthy = calls.at(-1)!;
  assert.match(healthy, /\[accent\]◆ fake-model/);
  assert.match(healthy, /\[success\]● mem/);
  assert.doesNotMatch(healthy, /mem off/);
  assert.match(healthy, /lark:bot/);

  const changedCalls: string[] = [];
  const changedCtx = { mode: "tui", model: { id: "other-model" }, ui: { ...fakeUi, setStatus: (_k: string, v: string) => changedCalls.push(v) } };
  await Promise.all(handlerLists.get("model_select")!.map((h) => h({ model: { id: "other-model" } }, changedCtx)));
  assert.match(changedCalls.at(-1)!, /other-model/);

  const degradedLists = new Map<string, Function[]>();
  const degradedCalls: string[] = [];
  corePolicyExtension(undefined, undefined, () => "Memory degraded")({
    on: (name: string, handler: Function) => { const list = degradedLists.get(name) ?? []; list.push(handler); degradedLists.set(name, list); },
    registerCommand: () => {},
  } as never);
  await Promise.all(degradedLists.get("session_start")!.map((h) => h({}, { mode: "tui", model: { id: "m" }, ui: { setStatus: (_k: string, v: string) => degradedCalls.push(v), theme: fakeUi.theme, notify: () => {}, getEditorComponent: () => undefined, setEditorComponent: () => {} } })));
  assert.match(degradedCalls.at(-1)!, /\[warning\]○ mem off/);

  // Print mode never sets footer status.
  const printCalls: string[] = [];
  await Promise.all(handlerLists.get("session_start")!.map((h) =>
    h({}, { mode: "print", model: { id: "m" }, ui: { setStatus: (_k: string, v: string) => printCalls.push(v), theme: fakeUi.theme, notify: () => {}, getEditorComponent: () => undefined, setEditorComponent: () => {} } })));
  assert.deepEqual(printCalls, []);
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

test("startup banner header renders brand, version, model, and cwd only in TUI", () => {
  const handlers = new Map<string, Function>();
  startupBannerExtension()({ on: (n: string, h: Function) => handlers.set(n, h), registerCommand: () => {} } as never);
  let factory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
  const theme = { fg: (_color: string, text: string) => text };
  handlers.get("session_start")!({}, {
    mode: "tui",
    model: { id: "gpt-test" },
    ui: { setHeader: (f: typeof factory) => { factory = f; } },
  });
  assert.ok(factory);
  const output = factory!(null, theme).render(120).join("\n");
  assert.match(output, /Feishu Agent/);
  assert.match(output, /v0\.1\.0/);
  assert.match(output, /gpt-test/);
  assert.match(output, /\/ commands/);

  let printSet = false;
  handlers.get("session_start")!({}, { mode: "print", ui: { setHeader: () => { printSet = true; } } });
  assert.equal(printSet, false);
});
