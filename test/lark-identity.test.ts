import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FeishuResourceLoader } from "../src/resources.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "dist/src/cli.js");

test("Lark identity guidance is explicit and token-copy free", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-lark-"));
  const home = join(root, "home", ".feishu-agent");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true }); mkdirSync(project, { recursive: true });
  const loader = new FeishuResourceLoader(home, project, "key"); await loader.reload();
  const prompt = loader.getSystemPrompt()!;
  assert.match(prompt, /--as user/); assert.match(prompt, /--as bot/); assert.match(prompt, /--help or schema/); assert.match(prompt, /without copying tokens/);
  assert.equal(existsSync(join(home, "lark.json")), false);
});

test("profile override is invocation-local and leaves Lark config unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-profile-"));
  const userHome = join(root, "home");
  const larkConfig = join(userHome, ".config", "lark-cli", "config.json");
  mkdirSync(dirname(larkConfig), { recursive: true });
  mkdirSync(join(userHome, ".feishu-agent"), { recursive: true });
  writeFileSync(larkConfig, '{"defaultProfile":"personal","token":"sentinel-not-copied"}');
  const before = readFileSync(larkConfig, "utf8");
  const result = spawnSync(process.execPath, [cli, "--lark-profile", "finance", "-p", "ignored"], { encoding: "utf8", env: { ...process.env, HOME: userHome, FEISHU_AGENT_INSPECT: "1" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).larkProfile, "finance");
  assert.equal(readFileSync(larkConfig, "utf8"), before);
  assert.equal(existsSync(join(userHome, ".feishu-agent", "config.json")), false);
});
