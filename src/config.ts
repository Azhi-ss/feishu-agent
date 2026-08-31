import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageManager } from "./packages.js";

export interface ConfigDispatchOptions {
  agentHome: string;
  projectRoot: string;
  projectKey: string;
  args: string[];
  spawnChild?: typeof spawn;
}

/** Run Pi's unmodified config UI in an isolated child so its process.exit cannot terminate an embedding host. */
export async function dispatchConfig(options: ConfigDispatchOptions): Promise<number> {
  const compatCwd = join(options.agentHome, ".compat", "projects", options.projectKey);
  packageManager(options.agentHome, options.projectRoot, options.projectKey);
  const args = [...options.args];
  const local = args.includes("-l") || args.includes("--local");
  if (local && !args.some((arg) => ["-a", "--approve", "-na", "--no-approve"].includes(arg))) args.push("--approve");
  const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const mainEntry = join(dirname(piEntry), "main.js");
  const script = `import(${JSON.stringify(new URL(`file://${mainEntry}`).href)}).then(({main})=>main(${JSON.stringify(["config", ...args])})).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1})`;
  const child = (options.spawnChild ?? spawn)(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: compatCwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: options.agentHome },
    stdio: "inherit",
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => signal ? reject(new Error(`Feishu config terminated by ${signal}`)) : resolve(code ?? 1));
  });
}
