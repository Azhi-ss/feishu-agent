import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const feishuCli = join(repoRoot, "dist", "src", "cli.js");
const piCli = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [command, ...args], { cwd, env, encoding: "utf8" });
}

test("public package CLIs keep Feishu packages invisible to Pi and update --extensions uses only Feishu storage", () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-package-cli-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const bin = join(root, "bin");
  const calls = join(root, "npm-calls.jsonl");
  mkdirSync(join(home, ".feishu-agent"), { recursive: true });
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const fakeNpm = join(bin, "fake-npm");
  writeFileSync(fakeNpm, `#!/usr/bin/env node\nconst fs=require('fs');\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+"\\n");\nconst args=process.argv.slice(2);\nif(args[0]==='view') process.stdout.write('"2.0.0"\\n');\nelse if(args[0]==='root') process.stdout.write(${JSON.stringify(join(root, "global-node_modules") + "\n")});\nelse if(args[0]==='install'){const i=args.indexOf('--prefix');const prefix=args[i+1];const spec=args[1];const name=spec.replace(/@[^@/]+$/, '').replace(/^npm:/, '');const dir=require('path').join(prefix,'node_modules',...name.split('/'));fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(require('path').join(dir,'package.json'),JSON.stringify({name,version:'2.0.0'}));}\n`, { mode: 0o755 });
  writeFileSync(join(home, ".feishu-agent", "settings.json"), JSON.stringify({ npmCommand: [fakeNpm], packages: ["npm:fixture-update"] }));
  writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ npmCommand: [fakeNpm], packages: ["npm:ordinary-pi-package@1.0.0"] }));
  mkdirSync(join(home, ".feishu-agent", "npm", "node_modules", "fixture-update"), { recursive: true });
  writeFileSync(join(home, ".feishu-agent", "npm", "node_modules", "fixture-update", "package.json"), JSON.stringify({ name: "fixture-update", version: "1.0.0" }));
  const piSettingsBefore = readFileSync(join(home, ".pi", "agent", "settings.json"));
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    PI_OFFLINE: "0",
  };

  const feishuList = run(feishuCli, ["list"], project, env);
  assert.equal(feishuList.status, 0, feishuList.stderr);
  assert.match(feishuList.stdout, /fixture-update/);
  assert.doesNotMatch(feishuList.stdout, /ordinary-pi-package/);

  const piList = run(piCli, ["list"], project, env);
  assert.equal(piList.status, 0, piList.stderr);
  assert.match(piList.stdout, /ordinary-pi-package/);
  assert.doesNotMatch(piList.stdout, /fixture-update|\.feishu-agent/);

  const update = run(feishuCli, ["update", "--extensions"], project, env);
  assert.equal(update.status, 0, update.stderr);
  const npmCalls = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  const installs = npmCalls.filter((call) => call[0] === "install");
  assert(installs.length > 0);
  assert.deepEqual(installs.map((call) => call[call.indexOf("--prefix") + 1]), installs.map(() => join(home, ".feishu-agent", "npm")));
  assert(installs.some((call) => call.some((arg) => arg.includes("fixture-update"))));
  assert(!npmCalls.some((call) => call.some((arg) => arg.includes("ordinary-pi-package"))));
  assert.equal(JSON.parse(readFileSync(join(home, ".feishu-agent", "npm", "node_modules", "fixture-update", "package.json"), "utf8")).version, "2.0.0");
  assert.deepEqual(readFileSync(join(home, ".pi", "agent", "settings.json")), piSettingsBefore);
});
