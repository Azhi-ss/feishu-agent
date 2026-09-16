// OS managers supervise only the common Trigger; no native job schedules.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { AutomationError, acquireWorkspaceLock, ensureWorkspace, releaseWorkspaceLock, workspacePaths } from "./automation.js";
import { liveTrigger } from "./automation-trigger.js";

const MARKER = "Feishu managed Automation Trigger v1";
const AVAILABILITY = "Scheduling requires a live host and Trigger. Sleep, power-off, WSL shutdown, and logout without an active user manager prevent execution. Use `feishu automation serve` as a foreground fallback; keep that process alive.";

function executable(name: string): string {
  const candidates = name.includes("/") ? [resolve(name)] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(dir => resolve(dir, name));
  for (const path of candidates) {
    try { accessSync(path, constants.X_OK); } catch { continue; }
    if (!lstatSync(realpathSync(path)).isFile()) continue;
    // Keep the installed entry point (npm symlinks and shims can rely on its name).
    return path;
  }
  throw new AutomationError(`Required executable ${name} is unavailable. Fix PATH and retry; ${AVAILABILITY}`);
}

function service(root: string) {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new AutomationError(`Background automation supports macOS and Linux/WSL only. ${AVAILABILITY}`);
  }
  const mac = process.platform === "darwin";
  const id = `org.feishu-agent.automation-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
  const name = `${id}.service`;
  const target = `gui/${process.getuid!()}/${id}`;
  const path = mac ? join(homedir(), "Library", "LaunchAgents", `${id}.plist`) : join(homedir(), ".config", "systemd", "user", name);
  const manager = executable(mac ? "launchctl" : "systemctl");
  const call = (args: string[]): string => {
    try {
      return execFileSync(manager, mac ? args : ["--user", ...args], {
        encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      // launchctl's documented absent-service status is not a manager failure.
      if (mac && args[0] === "print" && args[1] === target && (error as { status?: number }).status === 113) return "";
      // Manager diagnostics can contain its inherited environment; never echo them.
      throw new AutomationError(`${mac ? "launchctl" : "systemctl --user"} ${args[0]} failed. Inspect the owned service ${id} with your user manager. ${AVAILABILITY}`);
    }
  };
  const probe = (): void => { call(mac ? ["print", `gui/${process.getuid!()}`] : ["show-environment"]); };
  const pid = (): number | null => {
    if (mac) {
      return Number(call(["print", target]).match(/\bpid = (\d+)/)?.[1]) || null;
    }
    return Number(call(["show", name, "--property=MainPID", "--value"]).trim()) || null;
  };
  const stop = (): void => {
    if (mac) {
      call(["disable", target]);
      // Loaded jobs can be between restarts with no PID; unload those too.
      if (call(["print", target])) call(["bootout", target]);
    } else call(["disable", "--now", name]);
  };
  const start = (): void => {
    if (mac) { call(["enable", target]); call(["bootstrap", `gui/${process.getuid!()}`, path]); }
    else { call(["daemon-reload"]); call(["enable", name]); call(["start", name]); }
  };
  return { mac, id, path, probe, pid, stop, start, call };
}

type Service = ReturnType<typeof service>;

function artifact(s: Service, root: string): string {
  const node = realpathSync(executable(process.execPath));
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  accessSync(cli, constants.R_OK);
  const lark = executable("lark-cli");
  const env = executable("/usr/bin/env");
  // Clear the manager's environment too: allowlisting the caller alone would
  // still inherit manager-imported model/Mem0/Remote secrets.
  const path = [...new Set([dirname(node), dirname(lark), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(delimiter);
  const argv = [env, "-i", `HOME=${homedir()}`, `PATH=${path}`, "PI_OFFLINE=1", `FEISHU_AUTOMATION_HOME=${root}`, node, cli, "automation", "serve"];
  if (argv.some(value => /[\x00-\x1f\x7f]/.test(value))) throw new AutomationError("Service paths must not contain control characters.");
  if (s.mac) {
    const xml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<!-- ${MARKER} -->\n<key>Label</key><string>${s.id}</string>\n<key>ProgramArguments</key><array>${argv.map(value => `<string>${xml(value)}</string>`).join("")}</array>\n<key>WorkingDirectory</key><string>${xml(root)}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>10</integer>\n<key>ExitTimeOut</key><integer>20</integer>\n</dict></plist>\n`;
  }
  const quote = (value: string): string => JSON.stringify(value.replaceAll("%", "%%").replaceAll("$", "$$"));
  return `# ${MARKER}\n[Unit]\nDescription=Feishu Automation Trigger\n[Service]\nType=simple\nExecStart=${argv.map(quote).join(" ")}\nWorkingDirectory=${JSON.stringify(root.replaceAll("%", "%%"))}\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=20\nKillMode=mixed\n[Install]\nWantedBy=default.target\n`;
}

function installed(s: Service): string | null {
  if (!existsSync(s.path)) return null;
  if (!lstatSync(s.path).isFile()) throw new AutomationError(`Refusing to replace a non-regular service artifact at ${s.path}.`);
  const text = readFileSync(s.path, "utf8");
  if (!text.includes(MARKER)) throw new AutomationError(`Service artifact at ${s.path} is not owned by Feishu; resolve the conflict before retrying.`);
  return text;
}

function publish(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
}

function snapshot(root: string, s: Service | null, managerError: string | null = null) {
  const trigger = liveTrigger(workspacePaths(root));
  const managerPid = s ? s.pid() : null;
  return {
    triggerRunning: trigger !== null, triggerPid: trigger?.pid ?? null,
    owner: trigger ? (managerError ? "unknown" : managerPid === trigger.pid ? "service" : "foreground") : null,
    serviceInstalled: s ? installed(s) !== null : null, servicePid: managerPid,
    managerError, notice: `${trigger ? "Trigger is running." : "Trigger is not running; enabled jobs are not guaranteed to fire."} ${AVAILABILITY}`,
  };
}

async function waitStopped(root: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (liveTrigger(workspacePaths(root)) && Date.now() < deadline) await delay(100);
  if (liveTrigger(workspacePaths(root))) {
    throw new AutomationError("A Trigger remains active. Stop its foreground owner with Ctrl-C, or inspect the owned service and retry; jobs/history and independent manual runs are retained.");
  }
}

// Resolve existing ancestors even before first setup creates the workspace.
// Otherwise a symlinked HOME/parent changes the service identity after start.
function canonicalPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  return join(canonicalPath(dirname(path)), basename(path));
}

export async function automationService(rootArg: string, verb: "start" | "stop" | "status") {
  const root = canonicalPath(resolve(rootArg));
  let s: Service;
  try { s = service(root); s.probe(); }
  catch (error) {
    if (verb !== "status") throw error;
    return snapshot(root, null, error instanceof Error ? error.message : "User manager unavailable.");
  }
  if (verb === "status") return snapshot(root, s);
  // Serialize install/rollback/stop, not job execution or lifecycle editing.
  const lock = join(root, "service.lock");
  acquireWorkspaceLock(lock, { pid: process.pid }, () => "Another service operation is in progress; retry after it finishes.");
  try {
    const previous = installed(s);
    if (verb === "stop") {
      if (previous !== null) s.stop();
      await waitStopped(root);
      return snapshot(root, s);
    }
    const before = snapshot(root, s);
    if (before.triggerRunning && before.owner !== "service") {
      throw new AutomationError("A foreground Trigger already owns this workspace. Stop it with Ctrl-C before automation start.");
    }
    const text = artifact(s, root); // prerequisite checks before changing the installation
    if (before.owner === "service" && previous === text) return before;
    const workspace = ensureWorkspace(root);
    accessSync(workspace.root, constants.R_OK | constants.W_OK | constants.X_OK);
    accessSync(workspace.jobs, constants.R_OK | constants.W_OK | constants.X_OK);
    try {
      if (previous !== null) { s.stop(); await waitStopped(root); }
      publish(s.path, text);
      s.start();
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const result = snapshot(root, s);
        if (result.triggerRunning && result.owner === "service") return result;
        await delay(100);
      }
      throw new AutomationError("Service started but no live owned Trigger appeared; inspect automation status before retrying.");
    } catch (error) {
      // Keep the prior configuration, but intentionally leave it stopped. Never
      // mask rollback failure or claim that enabled schedules will execute.
      try { s.stop(); }
      catch { throw new AutomationError(`Service setup failed and rollback could not stop ${s.id}. Inspect the user manager and run automation stop before retrying; preserved artifact: ${s.path}.`); }
      await waitStopped(root);
      if (previous === null) rmSync(s.path, { force: true });
      else publish(s.path, previous);
      if (!s.mac) s.call(["daemon-reload"]);
      throw new AutomationError(`Service setup failed; owned service disabled and prior configuration ${previous === null ? "absent" : "restored"}. ${error instanceof Error ? error.message : "Inspect automation status before retrying."}`);
    }
  } finally { releaseWorkspaceLock(lock); }
}
