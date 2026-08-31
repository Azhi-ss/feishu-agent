import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dispatchConfig } from "../src/config.js";

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
