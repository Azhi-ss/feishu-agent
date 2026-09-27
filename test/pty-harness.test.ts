import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runPty } from "./helpers/remote-bridge-fixture.js";
import { runPty as runHarness } from "./helpers/pty-harness.js";

// Regression: the PTY harness matched each action against the output since the
// previous match, but advanced that window to the end of the read buffer. When a
// slow run delivered two action patterns in ONE read (routine under full-suite
// load, and the cause of a real CI failure in remote-bridge-stream), the second
// pattern sat behind the new window and the harness waited for it until timeout.
test("the PTY harness advances actions whose patterns arrive in one read", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-pty-harness-"));
  const fakeCli = join(root, "fake-cli.js");
  // Both patterns are written in a single chunk, and the process stays alive
  // until the harness's second action sends its input — like the real CLI.
  writeFileSync(fakeCli, `process.stdout.write("FIRST-PATTERN SECOND-PATTERN\\n");\nprocess.stdin.on("data", () => process.exit(0));\n`);
  const result = await runPty(root, [], { ...process.env }, [
    { wait: "FIRST-PATTERN", send: "" },
    { wait: "SECOND-PATTERN", send: "/quit\r" },
  ], 5, undefined, fakeCli);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /FIRST-PATTERN SECOND-PATTERN/);
});

test("the PTY harness still advances waitFile actions that carry no wait pattern", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-pty-harness-file-"));
  const fakeCli = join(root, "fake-cli.js");
  const release = join(root, "release");
  writeFileSync(fakeCli, `process.stdout.write("WAIT-FILE-READY\\n");\nprocess.stdin.on("data", () => process.exit(0));\n`);
  setTimeout(() => writeFileSync(release, ""), 300);
  const result = await runPty(root, [], { ...process.env }, [
    { wait: "WAIT-FILE-READY", send: "" },
    { waitFile: release, send: "/quit\r" },
  ], 5, undefined, fakeCli);
  assert.equal(result.code, 0, result.output);
});

// Contract: run-level case-insensitive matching. All five ptyRun call sites
// match prompts with /i, and a stricter default keeps real mismatches visible.
test("the harness matches a pattern case-insensitively when asked", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-pty-case-"));
  const fakeCli = join(root, "fake-cli.js");
  writeFileSync(fakeCli, `process.stdout.write("Create this Automation Job?\\n");\nprocess.stdin.on("data", () => process.exit(0));\n`);
  const result = await runHarness(root, [], { ...process.env }, [
    { wait: "create this automation job?", send: "/quit\r" },
  ], { timeoutSec: 5, cliPath: fakeCli, ignoreCase: true });
  assert.equal(result.code, 0, result.output);
});

test("the harness still distinguishes case by default", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-pty-case-strict-"));
  const fakeCli = join(root, "fake-cli.js");
  writeFileSync(fakeCli, `process.stdout.write("Create this Automation Job?\\n");\nprocess.stdin.on("data", () => process.exit(0));\n`);
  const result = await runHarness(root, [], { ...process.env }, [
    { wait: "create this automation job?", send: "/quit\r" },
  ], { timeoutSec: 2, cliPath: fakeCli });
  assert.equal(result.code, 124, "a case-mismatched pattern must not match by default");
});

// Contract: an action may create a file when its pattern matches, so a test can
// synchronise with the harness from the outside (the lifecycle handshakes).
test("the harness creates an action's markFile when the pattern matches", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-pty-mark-"));
  const fakeCli = join(root, "fake-cli.js");
  const markFile = join(root, "prompt-seen.ready");
  writeFileSync(fakeCli, `process.stdout.write("Apply this update?\\n");\nprocess.stdin.on("data", () => process.exit(0));\n`);
  const result = await runHarness(root, [], { ...process.env }, [
    { wait: "Apply this update?", markFile, send: "/quit\r" },
  ], { timeoutSec: 5, cliPath: fakeCli });
  assert.equal(result.code, 0, result.output);
  assert.equal(existsSync(markFile), true, "markFile was not created on match");
});

// Contract: "the child exited while actions were still outstanding" must report
// 125 on every path. The read-EOF path used to leak the child's own exit code, so
// the same situation reported 1 or 125 depending on which check ran first.
test("an early child exit reports 125, never the child's own code", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-pty-early-exit-"));
  const fakeCli = join(root, "fake-cli.js");
  writeFileSync(fakeCli, `process.exit(7);\n`);
  const result = await runHarness(root, [], { ...process.env }, [{ wait: "NEVER-PRINTED", send: "" }], { timeoutSec: 5, cliPath: fakeCli });
  assert.equal(result.code, 125, result.output);
});

// Contract: an inline PTY script used by exactly one test may stay put, but it
// must carry the label. The label is what forces "is this really used once?"
// before a sixth copy gets written; true duplication is not mechanically
// decidable, so this guard checks the label, not the duplication.
test("inline PTY scripts carry the single-test label", () => {
  // Assembled from parts so this file's own source contains neither the needle nor
  // the label: otherwise the guard would have to exempt itself from the rule it
  // enforces, and a real inline script added here would slip through.
  const needle = ["pty", "fork()"].join(".");
  const label = ["// single-test PTY", "script: not shared"].join(" ");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const offenders = readdirSync(join(root, "test"), { recursive: true })
    .map(String)
    .filter((path) => path.endsWith(".ts"))
    .filter((path) => path !== join("helpers", "pty-harness.ts"))
    .map((path) => [path, readFileSync(join(root, "test", path), "utf8")] as const)
    .filter(([, content]) => content.includes(needle))
    .filter(([, content]) => !content.includes(label))
    .map(([path]) => path);
  assert.deepEqual(offenders, [], `inline PTY scripts must carry "${label}" (or use the shared harness): ${offenders.join(", ")}`);
});
