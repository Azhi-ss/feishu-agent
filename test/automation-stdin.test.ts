import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fixture, baseEnv, cli, runCli, createCliHarness } from "./helpers/automation-cli-fixture.js";

const { modelServers } = createCliHarness();

test("automation add and update wait for complete delayed stdin, preserving multiple buffers", { timeout: 15_000 }, async (t) => {
  const f = await fixture();
  modelServers.push(f.model.server);
  for (const args of [
    ["add", "--name", "streamed", "--every", "90m"],
    ["update", "streamed"],
  ]) {
    const child = spawn(process.execPath, [cli, "automation", ...args, "--prompt-stdin", "--yes"], {
      cwd: f.root, env: baseEnv(f),
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    // A broken reader may exit before the producer writes. Assert its exit and
    // receipt below rather than letting EPIPE hide the original CLI diagnostic.
    child.stdin.on("error", () => {});
    const closed = once(child, "close");
    await delay(600);
    const first = `${args[0]} objective: ` + "A".repeat(70_000);
    child.stdin.write(first);
    await delay(150);
    const last = "\nInputs and fixed destination: doc-existing. Append as user.\n";
    child.stdin.end(last);
    const [code] = await closed;
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).name, "streamed");
    const shown = runCli(f, ["automation", "show", "streamed"]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).task, (first + last).trimEnd());
  }
});
