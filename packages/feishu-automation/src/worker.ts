// Admission belongs to the optional package, not to the Feishu Runtime.

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (process.env.FEISHU_UNATTENDED !== "1" || !process.send || !process.connected) {
  fail("Automation admission requires a connected supervisor.");
}
await new Promise<void>((resolve) => {
  const disconnected = (): void => fail("Automation supervisor disconnected before admission; no task was started.");
  const admitted = (message: unknown): void => {
    if (!message || typeof message !== "object" || !("type" in message) || message.type !== "automation-admit") return;
    process.off("disconnect", disconnected);
    process.off("message", admitted);
    process.disconnect();
    resolve();
  };
  process.once("disconnect", disconnected);
  process.on("message", admitted);
  process.send!({ type: "automation-ready" });
});
const [command, prompt] = process.argv.slice(2);
if (!command || !prompt) fail("Automation worker requires a Feishu executable and task.");
// POSIX exec preserves the admitted PID and process group: no intermediary
// can die while leaving an untracked Print child executing business writes.
if (!process.execve) fail("Automation requires Node >=22.19 on macOS or Linux.");
try { process.execve(command, [command, "-p", prompt], process.env); }
catch { fail("Cannot start Feishu; check the installed executable and PATH."); }
