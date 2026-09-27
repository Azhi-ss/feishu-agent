import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runPty } from "./helpers/remote-bridge-fixture.js";

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
