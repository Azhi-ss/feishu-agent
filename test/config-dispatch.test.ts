import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { dispatchConfig } from "../src/config.js";
import { FeishuResourceLoader } from "../src/resources.js";
import { packageManager } from "../src/packages.js";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli.js");


function fixture(args: string[]) {
  const root = mkdtempSync(join(tmpdir(), "feishu-config-"));
  const agentHome = join(root, "home", ".feishu-agent");
  const projectRoot = join(root, "project");
  let childArgs: string[] = [];
  let childOptions: any;
  const spawnChild = ((_command: string, passed: string[], options: any) => {
    childArgs = passed;
    childOptions = options;
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  }) as never;
  return dispatchConfig({ agentHome, projectRoot, projectKey: "project-key", args, spawnChild }).then((code) => ({ code, childArgs, childOptions, agentHome, projectRoot }));
}

test("scripted config toggles persist by scope and change the next Feishu ResourceLoader", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-config-toggle-"));
  const agentHome = join(root, "home", ".feishu-agent");
  const projectRoot = join(root, "project");
  const pkg = join(root, "package");
  const pi = join(root, "home", ".pi", "agent");
  mkdirSync(join(pkg, "extensions"), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(pi, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "toggle", version: "1.0.0", pi: { extensions: ["extensions"] } }));
  writeFileSync(join(pkg, "extensions", "toggle.js"), "export default pi => pi.registerCommand('toggle-command', { description: 'toggle', handler() {} })\n");
  writeFileSync(join(pi, "settings.json"), "PI-SETTINGS-BYTES");
  const manager = packageManager(agentHome, projectRoot, "project-key");
  await manager.installAndPersist(pkg);
  const installedSource = manager.listConfiguredPackages().find((entry) => entry.scope === "user")!.source;
  let projectSource = "";
  const load = async () => { const loader = new FeishuResourceLoader(agentHome, projectRoot, "project-key"); await loader.reload(); return loader.getExtensions().extensions.some((extension) => extension.path.endsWith("toggle.js")); };
  assert.equal(await load(), true);
  const runConfig = (local: boolean, state: "on" | "off") => spawnSync(process.execPath, [cli, "config", ...(local ? ["-l"] : []), "set", local ? projectSource : installedSource, "extensions", state], { cwd: projectRoot, env: { ...process.env, HOME: join(root, "home") }, encoding: "utf8" });
  assert.equal(runConfig(false, "off").status, 0);
  assert.equal(await load(), false);
  assert.equal(runConfig(false, "on").status, 0);
  assert.equal(await load(), true);
  await manager.installAndPersist(pkg, { local: true });
  projectSource = manager.listConfiguredPackages().find((entry) => entry.scope === "project")!.source;
  assert.equal(runConfig(true, "off").status, 0);
  const projectSettings = readFileSync(join(projectRoot, ".feishu-agent", "settings.json"), "utf8");
  assert.match(projectSettings, /"extensions": \[\]/);
  assert.equal(readFileSync(join(pi, "settings.json"), "utf8"), "PI-SETTINGS-BYTES");
});


test("config dispatch is isolated, preserves scope, and cannot exit the embedded process", async () => {
  const global = await fixture([]);
  assert.equal(global.code, 0);
  assert.match(global.childOptions.cwd, /\.feishu-agent\/\.compat\/projects\/project-key$/);
  assert.equal(global.childOptions.env.PI_CODING_AGENT_DIR, global.agentHome);
  assert.match(global.childArgs.at(-1)!, /\["config"\]/);

  const local = await fixture(["-l"]);
  assert.match(local.childArgs.at(-1)!, /\["config","-l","--approve"\]/);
  const explicitTrust = await fixture(["-l", "--no-approve"]);
  assert.match(explicitTrust.childArgs.at(-1)!, /\["config","-l","--no-approve"\]/);
  assert.doesNotMatch(explicitTrust.childArgs.at(-1)!, /--approve/);
});
