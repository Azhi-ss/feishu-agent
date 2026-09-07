import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireRemoteLock,
  clearHandoffRequest,
  describeHolder,
  hasHandoffRequest,
  readRemoteLock,
  releaseRemoteLock,
  requestRemoteHandover,
  waitForRemoteLockRelease,
} from "../packages/feishu-remote/extensions/remote-lock.js";
import { remoteBridgeExtension } from "../packages/feishu-remote/index.js";

const APP_ID = "cli_lock_unit";

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "feishu-lock-"));
  mkdirSync(join(home, ".cache", "feishu-remote"), { recursive: true });
  return home;
}

function lockPath(home: string): string {
  return join(home, ".cache", "feishu-remote", `${APP_ID}.lock`);
}

function yieldPath(home: string): string {
  return join(home, ".cache", "feishu-remote", `${APP_ID}.yield`);
}

test("a fresh lock is written as JSON metadata with pid, startedAt and cwd", () => {
  const home = tempHome();
  try {
    const result = acquireRemoteLock(home, APP_ID, 12345, "/tmp/some-project");
    assert.equal(result.ok, true);
    const parsed = JSON.parse(readFileSync(lockPath(home), "utf8"));
    assert.equal(parsed.pid, 12345);
    assert.equal(parsed.cwd, "/tmp/some-project");
    assert.ok(typeof parsed.startedAt === "string" && parsed.startedAt.length > 0);
    releaseRemoteLock(home, APP_ID, 12345);
    assert.equal(existsSync(lockPath(home)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a legacy plain-pid lock file is still read and reported as busy when alive", () => {
  const home = tempHome();
  try {
    writeFileSync(lockPath(home), `${process.pid}\n`);
    const holder = readRemoteLock(home, APP_ID);
    assert.ok(holder);
    assert.equal(holder!.pid, process.pid);
    const result = acquireRemoteLock(home, APP_ID, 99999, process.cwd());
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, new RegExp(`pid ${process.pid}`));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a lock held by a dead pid is reclaimed on acquire", async () => {
  const home = tempHome();
  try {
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise<void>((done) => dead.on("exit", () => done()));
    writeFileSync(lockPath(home), JSON.stringify({ pid: dead.pid, startedAt: new Date().toISOString(), cwd: "/tmp/old-project" }));
    const result = acquireRemoteLock(home, APP_ID, process.pid, process.cwd());
    assert.equal(result.ok, true);
    const parsed = JSON.parse(readFileSync(lockPath(home), "utf8"));
    assert.equal(parsed.pid, process.pid);
    releaseRemoteLock(home, APP_ID, process.pid);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the holder description names the project directory", () => {
  assert.match(describeHolder({ pid: 4242, startedAt: new Date().toISOString(), cwd: "/home/user/work/feishu-agent" }), /pid 4242 in feishu-agent/);
});

test("waitForRemoteLockRelease resolves when the holder releases, and times out otherwise", async () => {
  const home = tempHome();
  try {
    const acquired = acquireRemoteLock(home, APP_ID, 12345, "/tmp/project");
    assert.equal(acquired.ok, true);
    const timedOut = await waitForRemoteLockRelease(home, APP_ID, 300);
    assert.equal(timedOut, false);
    releaseRemoteLock(home, APP_ID, 12345);
    const released = await waitForRemoteLockRelease(home, APP_ID, 2000);
    assert.equal(released, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** A live holder process so the handover request has an alive target pid. */
function liveHolder(): { pid: number; stop(): void } {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 60000)"], { stdio: "ignore", detached: true });
  assert.ok(child.pid);
  return { pid: child.pid!, stop: () => { try { child.kill("SIGTERM"); } catch { /* already exited */ } } };
}

function waitFor<T>(check: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const value = check();
      if (value !== undefined) return resolve(value);
      if (Date.now() - start > timeoutMs) return reject(new Error("wait timed out"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

test("requestRemoteHandover writes a fresh yield file the holder can consume", async () => {
  const home = tempHome();
  const holder = liveHolder();
  try {
    writeFileSync(lockPath(home), JSON.stringify({ pid: holder.pid, startedAt: new Date().toISOString(), cwd: process.cwd() }));
    assert.equal(requestRemoteHandover(home, APP_ID), true);
    const request = await waitFor(() => existsSync(yieldPath(home)) ? true : undefined);
    assert.equal(request, true);
    assert.equal(hasHandoffRequest(home, APP_ID, holder.pid + 1), true);
    assert.equal(hasHandoffRequest(home, APP_ID, process.pid), false, "the requester ignores its own request");
    clearHandoffRequest(home, APP_ID);
    assert.equal(existsSync(yieldPath(home)), false, "clearing removes the request");
    assert.equal(hasHandoffRequest(home, APP_ID, holder.pid + 1), false, "a cleared request is not seen again");
  } finally {
    holder.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test("requestRemoteHandover refuses when no live holder exists", () => {
  const home = tempHome();
  try {
    writeFileSync(lockPath(home), JSON.stringify({ pid: 999999, startedAt: new Date().toISOString(), cwd: "/tmp/project" }));
    assert.equal(requestRemoteHandover(home, APP_ID), false);
    assert.equal(existsSync(yieldPath(home)), false);
    assert.equal(existsSync(lockPath(home)), true, "a failed handover leaves the lock for the caller to reclaim");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a stale yield file older than the TTL is ignored", () => {
  const home = tempHome();
  try {
    const holder = liveHolder();
    try {
      writeFileSync(lockPath(home), JSON.stringify({ pid: holder.pid, startedAt: new Date().toISOString(), cwd: process.cwd() }));
      mkdirSync(join(home, ".cache", "feishu-remote"), { recursive: true });
      writeFileSync(yieldPath(home), JSON.stringify({ at: Date.now() - 20_000, requesterPid: 1 }));
      assert.equal(hasHandoffRequest(home, APP_ID, holder.pid + 1), false, "expired request is ignored");
      clearHandoffRequest(home, APP_ID);
    } finally {
      holder.stop();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("releasing the lock clears any pending yield file", () => {
  const home = tempHome();
  try {
    assert.equal(acquireRemoteLock(home, APP_ID, 12345, "/tmp/project").ok, true);
    // touch a pending request manually
    mkdirSync(join(home, ".cache", "feishu-remote"), { recursive: true });
    writeFileSync(yieldPath(home), JSON.stringify({ at: Date.now() }));
    releaseRemoteLock(home, APP_ID, 12345);
    assert.equal(existsSync(yieldPath(home)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("/remote registers argument completions for subcommands", () => {
  const registered: Record<string, { getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> }> = {};
  const mockPi = {
    registerCommand: (name: string, opts: any) => { registered[name] = opts; },
    on: () => {},
    registerProvider: () => {},
  };
  remoteBridgeExtension()(mockPi as any);
  assert.ok(registered.remote?.getArgumentCompletions, "/remote must register getArgumentCompletions");
  const all = registered.remote.getArgumentCompletions("");
  assert.deepEqual(all?.map((i) => i.value), ["start", "switch", "status", "stop"]);
  const st = registered.remote.getArgumentCompletions("st");
  assert.deepEqual(st?.map((i) => i.value), ["start", "status", "stop"]);
  const sw = registered.remote.getArgumentCompletions("sw");
  assert.deepEqual(sw?.map((i) => i.value), ["switch"]);
});
