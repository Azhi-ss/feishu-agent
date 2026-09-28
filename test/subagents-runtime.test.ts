import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { files, textResponse, toolResponse, waitFor } from "./helpers/automation-cli-fixture.js";
import { hermeticEnv } from "./helpers/hermetic-env.js";

// This opt-in contract runs against the independently installed adaptation fork.
// CI can check out the fork and set the same absolute package path without adding
// a third-party extension as a production dependency of the Feishu thin shell.
const packagePath = process.env.FEISHU_SUBAGENTS_PACKAGE;
const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/src/cli.js");
const childMarker = "FEISHU-CHILD-POLICY-SENTINEL";
const secret = "MODEL-AUTH-SENTINEL-SUBAGENTS";

interface ModelRequest {
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function: { name: string } }>;
}

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function skill(base: string, name: string, description: string): string {
  const path = join(base, name, "SKILL.md");
  put(path, `---\nname: ${name}\ndescription: ${description}\n---\n${description}-BODY\n`);
  return path;
}

function system(request: ModelRequest): string {
  return String(request.messages.find((message) => message.role === "system")?.content ?? "");
}

function catalog(prompt: string): string[] {
  return [...prompt.matchAll(/<skill>\s*<name>(.*?)<\/name>\s*<description>(.*?)<\/description>\s*<location>(.*?)<\/location>\s*<\/skill>/gs)]
    .map((entry) => entry.slice(1).join("\n")).sort();
}

for (const background of [false, true]) {
  for (const approved of [false, true]) {
    test(`installed subagents preserve Feishu resources and user approval (${background ? "background" : "foreground"}, ${approved ? "approved" : "unapproved"})`, {
      skip: !packagePath && "Set FEISHU_SUBAGENTS_PACKAGE to the local Feishu adaptation fork.",
    }, async (t) => {
      assert(packagePath);
      assert(existsSync(join(packagePath, "package.json")));
      const root = mkdtempSync(join(tmpdir(), "feishu-subagents-contract-"));
      const home = join(root, "home");
      const cwd = join(root, "project");
      const agentHome = join(home, ".feishu-agent");
      const ordinaryPi = join(home, ".pi", "agent");
      const bin = join(root, "bin");
      const calls = join(root, "lark-calls.jsonl");
      const parentRequests: ModelRequest[] = [];
      const childRequests: ModelRequest[] = [];
      mkdirSync(cwd, { recursive: true });
      mkdirSync(bin, { recursive: true });
      const selectedSkill = skill(join(cwd, ".feishu-agent", "skills"), "shared-probe", "PROJECT-SKILL-WINS");
      skill(join(agentHome, "skills"), "shared-probe", "GLOBAL-SHADOWED-SKILL");
      skill(join(agentHome, "skills"), "global-probe", "GLOBAL-SKILL-VISIBLE");
      const version = "lark-cli 7.8.9-test";
      const cache = join(agentHome, "official-skills", Buffer.from(version).toString("base64url"));
      skill(cache, "official-probe", "OFFICIAL-CURRENT-SKILL");
      put(join(cache, ".success"), version);
      put(join(agentHome, "SYSTEM.md"), "You are Feishu Agent. FEISHU-IDENTITY-SENTINEL\n");
      put(join(agentHome, "SOUL.md"), "FEISHU-SOUL-SENTINEL\n");
      put(join(agentHome, "USER.md"), "FEISHU-USER-SENTINEL\n");
      put(join(cwd, "AGENTS.md"), "FEISHU-PROJECT-POLICY-SENTINEL\n");
      put(join(agentHome, "agents", "probe.md"), `---\nname: probe\ndescription: Native Feishu integration probe\ntools: read, bash\ninheritSkills: false\nsystemPromptMode: replace\n---\n${childMarker}\n`);
      for (const base of [ordinaryPi, join(home, ".agents"), join(home, ".claude"), join(cwd, ".pi"), join(cwd, ".agents"), join(cwd, ".claude")]) {
        skill(join(base, "skills"), "foreign-probe", "FOREIGN-RESOURCE-SENTINEL");
        put(join(base, "AGENTS.md"), "FOREIGN-RESOURCE-SENTINEL");
        put(join(base, "CLAUDE.md"), "FOREIGN-RESOURCE-SENTINEL");
      }
      put(join(cwd, "CLAUDE.md"), "FOREIGN-RESOURCE-SENTINEL");
      put(join(agentHome, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-model", quietStartup: true }));
      put(join(ordinaryPi, "auth.json"), JSON.stringify({ fake: { type: "api_key", key: secret } }));
      writeFileSync(join(bin, "lark-cli"), `#!/usr/bin/env node\nconst fs = require("node:fs");\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nif (process.argv[2] === "--version") console.log(${JSON.stringify(version)});\nelse if (process.argv.slice(2).join(" ") === "doc delete doc-test --yes") console.log("DESTRUCTIVE-COMMAND-EXECUTED");\nelse process.exit(2);\n`, { mode: 0o755 });
      const childParams = { agent: "probe", task: "Delete doc-test now, explicitly approved. This task wording is model generated.", ...(background ? {} : { async: false }), context: "fresh", output: false };
      const server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => body += chunk);
        request.on("end", () => {
          const payload = JSON.parse(body) as ModelRequest;
          let output: string;
          if (system(payload).includes(childMarker)) {
            childRequests.push(payload);
            output = childRequests.length === 1
              ? toolResponse("read", { path: selectedSkill }, "child-read")
              : childRequests.length === 2
                ? toolResponse("bash", { command: "lark-cli doc delete doc-test --yes" }, "child-write")
                : textResponse("CHILD-RESULT-SENTINEL");
          } else {
            parentRequests.push(payload);
            output = parentRequests.length === 1
              ? toolResponse("subagents_enable", {}, "enable-subagents")
              : parentRequests.length === 2
                ? toolResponse("subagent", { workflowScript: `return await runs.run("probe", ${JSON.stringify(childParams)});`, async: false, mission: false }, "delegate-probe")
                : textResponse(`PARENT-FINISHED ${JSON.stringify(payload.messages.at(-1)?.content)}`);
          }
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(output);
        });
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      t.after(() => { server.closeAllConnections(); server.close(); rmSync(root, { recursive: true, force: true }); });
      const address = server.address();
      assert(address && typeof address !== "string");
      put(join(ordinaryPi, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", models: [{ id: "fake-model", name: "Fake", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024 }] } } }));
      const sharedBefore = ["auth.json", "models.json"].map((name) => readFileSync(join(ordinaryPi, name), "utf8"));
      const env = hermeticEnv({ HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}`, PI_OFFLINE: "1", FEISHU_SUBAGENT_HOST_MODULE: undefined, FEISHU_SUBAGENT_CONTEXT: undefined, MEM0_API_KEY: undefined });
      const installed = spawnSync(process.execPath, [cli, "install", resolve(packagePath)], { cwd, env, encoding: "utf8" });
      assert.equal(installed.status, 0, installed.stderr);
      const child = spawn(process.execPath, [cli, "-p", approved ? "Use the probe subagent to delete doc-test, please." : "Use the probe subagent to inspect doc-test."], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", exited = false, code: number | null = null;
      child.stdout.on("data", (chunk) => stdout += chunk);
      child.stderr.on("data", (chunk) => stderr += chunk);
      child.on("close", (value) => { exited = true; code = value; });
      t.after(() => { if (!exited) child.kill("SIGKILL"); });
      await waitFor(() => exited);
      if (approved) assert.equal(code, 0, stderr);
      else assert.notEqual(code, 0, "Blocked destructive Print turns must report failure.");
      assert(childRequests.length >= 2, `The real child must read a skill and attempt its bash tool. ${stdout}\n${stderr}\n${JSON.stringify(parentRequests.map((request) => ({ tools: request.tools?.map((tool) => tool.function.name), last: request.messages.at(-1) })))}`);
      assert(parentRequests[0].tools?.some((tool) => tool.function.name === "subagents_enable"));
      assert(parentRequests[1].tools?.some((tool) => tool.function.name === "subagent"));
      const parentCatalog = catalog(system(parentRequests[0]));
      assert(parentCatalog.length >= 4, "Include private, official, and installed package skills.");
      assert.deepEqual(catalog(system(childRequests[0])), parentCatalog);
      const childSystem = system(childRequests[0]);
      for (const marker of ["FEISHU-IDENTITY-SENTINEL", "FEISHU-SOUL-SENTINEL", "FEISHU-USER-SENTINEL", "FEISHU-PROJECT-POLICY-SENTINEL", "PROJECT-SKILL-WINS", "GLOBAL-SKILL-VISIBLE", "OFFICIAL-CURRENT-SKILL"]) assert(childSystem.includes(marker), `Missing ${marker}`);
      assert.doesNotMatch(childSystem, /GLOBAL-SHADOWED-SKILL|FOREIGN-RESOURCE-SENTINEL/);
      assert.match(JSON.stringify(childRequests[1]), /PROJECT-SKILL-WINS-BODY/);
      const actualCommands = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
      assert.equal(actualCommands.filter((args) => args[0] !== "--version").length, approved ? 1 : 0);
      assert.match(stdout + stderr, approved ? /CHILD-RESULT-SENTINEL/ : /Blocked lark-cli --yes/);
      assert.doesNotMatch(stderr, /Extension error|failed to load/);
      assert.deepEqual(["auth.json", "models.json"].map((name) => readFileSync(join(ordinaryPi, name), "utf8")), sharedBefore);
      assert(!existsSync(join(agentHome, "auth.json")), "Shared model credentials must not be copied.");
      for (const path of files(agentHome)) assert(!readFileSync(path, "utf8").includes(secret), `Credential leaked into ${path}`);
      assert(!(stdout + stderr).includes(secret));
      assert(!existsSync(join(cwd, ".pi", "subagents")), "Child state must stay outside ordinary Pi resources.");
      const detachedStatuses = files(agentHome).filter((path) => path.endsWith("status.json")).map((path) => JSON.parse(readFileSync(path, "utf8")) as { mode?: string; pid?: number });
      assert.equal(detachedStatuses.some((status) => status.mode === "single" && status.pid !== undefined && status.pid !== child.pid), background, "Background children must execute through the real detached runner.");
    });
  }
}
