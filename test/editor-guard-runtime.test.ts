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
test("status line shows only Memory and official Skill readiness, while Pi owns native model/context/footer data", async () => {
  const handlerLists = new Map<string, Function[]>();
  const on = (name: string, handler: Function) => handlerLists.set(name, [...(handlerLists.get(name) ?? []), handler]);
  const calls: Array<[string, string | undefined]> = [];
  const theme = { fg: (color: string, text: string) => `[${color}]${text}[/${color}]` };
  const resourceLoader = { getSystemPrompt: () => undefined, getSkillsStatus: () => "ready" as const };
  corePolicyExtension(undefined, undefined, () => undefined, resourceLoader)({ on, registerCommand: () => {} } as never);
  const ctx = {
    mode: "tui",
    model: { id: "must-not-appear" },
    ui: { theme, setStatus: (key: string, value: string | undefined) => calls.push([key, value]), getEditorComponent: () => undefined, setEditorComponent: () => {}, notify: () => {} },
  };
  await Promise.all(handlerLists.get("session_start")!.map((handler) => handler({}, ctx)));
  const output = calls.map(([, value]) => value ?? "").join(" ");
  assert.match(output, /● mem/);
  assert.match(output, /│ → skills:ready/);
  assert.doesNotMatch(output, /must-not-appear|context|provider|cwd|thinking|auth status/);
  assert.equal(handlerLists.has("model_select"), false);
  assert.equal(handlerLists.has("turn_start"), false);

  const degraded: Array<[string, string | undefined]> = [];
  const degradedHandlers = new Map<string, Function[]>();
  corePolicyExtension(undefined, undefined, () => "degraded", { getSystemPrompt: () => undefined, getSkillsStatus: () => "cached" as const })({
    on: (name: string, handler: Function) => degradedHandlers.set(name, [...(degradedHandlers.get(name) ?? []), handler]),
    registerCommand: () => {},
  } as never);
  const degradedCtx = { mode: "tui", ui: { theme, setStatus: (key: string, value: string | undefined) => degraded.push([key, value]), getEditorComponent: () => undefined, setEditorComponent: () => {}, notify: () => {} } };
  await Promise.all(degradedHandlers.get("session_start")!.map((handler) => handler({}, degradedCtx)));
  assert.match(degraded.map(([, value]) => value ?? "").join(" "), /○ mem off/);
  assert.match(degraded.map(([, value]) => value ?? "").join(" "), /skills:cached/);

  const print: Array<[string, string | undefined]> = [];
  await Promise.all(handlerLists.get("session_start")!.map((handler) => handler({}, { mode: "print", ui: { setStatus: (key: string, value: string | undefined) => print.push([key, value]) } })));
  assert.deepEqual(print, []);
});

test("resume startup extension registers a host-owned current-project selector command", () => {
  const commands: string[] = [];
  corePolicyExtension(undefined, async () => {})({
    on: () => {},
    registerCommand: (name: string) => commands.push(name),
  } as never);
  assert.deepEqual(commands, ["feishu-resume"]);
});

test("host-owned commands remain core-owned after package command collisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-command-collision-"));
  const agentHome = join(root, "home", ".feishu-agent");
  const project = join(root, "project");
  const pkg = join(root, "package");
  mkdirSync(join(pkg, "extensions"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "command-collision", version: "1.0.0", pi: { extensions: ["extensions"] } }));
  writeFileSync(join(pkg, "extensions", "collision.js"), "export default pi => { pi.registerCommand('feishu-resume', { description: 'collision', handler: async () => {} }); pi.registerCommand('find-skill', { description: 'collision', handler: async () => {} }); }\n");
  await packageManager(agentHome, project, "key").installAndPersist(pkg);
  const loader = new FeishuResourceLoader(agentHome, project, "key");
  loader.setSessionSwitcher(async () => {});
  await loader.reload();
  const loaded = loader.getExtensions();
  const runner = new ExtensionRunner(loaded.extensions, createExtensionRuntime(), project, {} as never, {} as never);
  assert.equal(runner.getCommand("feishu-resume")?.sourceInfo.path, "<inline:feishu-core-policy>");
  assert.equal(runner.getCommand("find-skill")?.sourceInfo.path, "<inline:feishu-find-skill>");
  assert.match(loader.warnings.join("\n"), /cannot replace reserved core command feishu-resume/);
  assert.match(loader.warnings.join("\n"), /cannot replace reserved core command find-skill/);
});

test("startup banner header renders brand, version, model, and cwd only in TUI", () => {
  const handlers = new Map<string, Function>();
  startupBannerExtension()({ on: (n: string, h: Function) => handlers.set(n, h), registerCommand: () => {} } as never);
  let factory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
  const usedColors = new Set<string>();
  const theme = { fg: (color: string, text: string) => { usedColors.add(color); return text; } };
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
  assert.deepEqual([...usedColors].sort(), ["accent", "dim", "muted"]);

  let printSet = false;
  handlers.get("session_start")!({}, { mode: "print", ui: { setHeader: () => { printSet = true; } } });
  assert.equal(printSet, false);
});

test("skills status reflects dynamic resource loader status across reload", async () => {
  let currentStatus: "cached" | "ready" | "unavailable" = "cached";
  const loader = { getSystemPrompt: () => undefined, getSkillsStatus: () => currentStatus };
  const handlerLists = new Map<string, Function[]>();
  const on = (name: string, handler: Function) => handlerLists.set(name, [...(handlerLists.get(name) ?? []), handler]);
  const calls: Array<[string, string | undefined]> = [];
  const theme = { fg: (_c: string, text: string) => text };
  corePolicyExtension(undefined, undefined, () => undefined, loader)({ on, registerCommand: () => {} } as never);
  const ctx = {
    mode: "tui",
    ui: { theme, setStatus: (key: string, value: string | undefined) => calls.push([key, value]), getEditorComponent: () => undefined, setEditorComponent: () => {}, notify: () => {} },
  };
  await Promise.all(handlerLists.get("session_start")!.map((handler) => handler({ type: "session_start", reason: "startup" }, ctx)));
  assert.match(calls.find(([k]) => k === "feishu-2-skills")![1]!, /skills:cached/);

  // Dynamic reload updates the loader state:
  currentStatus = "ready";
  calls.length = 0;
  await Promise.all(handlerLists.get("session_start")!.map((handler) => handler({ type: "session_start", reason: "reload" }, ctx)));
  assert.match(calls.find(([k]) => k === "feishu-2-skills")![1]!, /skills:ready/);
});

test("startup banner respects NO_COLOR", () => {
  const handlers = new Map<string, Function>();
  startupBannerExtension()({ on: (n: string, h: Function) => handlers.set(n, h), registerCommand: () => {} } as never);
  let factory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
  const theme = { fg: (color: string, text: string) => `\x1b[31m${text}\x1b[0m` };
  handlers.get("session_start")!({}, {
    mode: "tui",
    model: { id: "gpt-test" },
    ui: { setHeader: (f: typeof factory) => { factory = f; } },
  });
  assert.ok(factory);
  const oldNoColor = process.env.NO_COLOR;
  try {
    process.env.NO_COLOR = "1";
    const plain = factory!(null, theme).render(120).join("\n");
    assert.doesNotMatch(plain, /\x1b\[/);
    assert.match(plain, /Feishu Agent/);
  } finally {
    if (oldNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = oldNoColor;
  }
});
