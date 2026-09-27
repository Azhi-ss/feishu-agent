import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// One PTY driver for the multi-action tests (remote bridge, reasoning replay,
// interactive runtime, release matrix, automation workflow). Each action waits
// for a pattern (or a file), then sends input; the run fails on the harness
// timeout, on a child exit with actions outstanding (125), or passes with the
// child's own exit code.
//
// The search window starts AFTER the previously matched pattern. Anchoring it
// anywhere else drops patterns that arrive together with the previous one or
// split across two reads — both shapes have failed real runs (see
// docs/agents/test-timing.md).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const defaultCliPath = join(repoRoot, "dist/src/cli.js");

export interface PtyAction {
  /** Pattern to wait for in the child's output before sending `send`. */
  wait?: string;
  /** Path that must exist before sending `send` (mutually exclusive with `wait`). */
  waitFile?: string;
  send?: string;
}

export interface PtyOptions {
  /** Harness timeout. Default 60s. */
  timeoutSec?: number;
  /** CLI entry to drive. Default `dist/src/cli.js`. */
  cliPath?: string;
  /** Kill the CLI this many seconds after the last action matched (exit 0). */
  killAfterLastActionSec?: number;
  /** Emit `PTY_TIMEOUT {json}` with a progress snapshot instead of raw output. */
  diagnostics?: boolean;
  /** Resend the previous input after a 5s stall, and the last input until it lands. */
  resend?: boolean;
  /** Progress snapshot for the timeout diagnostic; only used with `diagnostics`. */
  onTimeoutProgress?: () => Record<string, number>;
}

const python = `
import json,os,pty,select,sys,time
actions=json.loads(sys.argv[4]); argv=json.loads(sys.argv[5])
timeout=float(sys.argv[6]); opts=json.loads(sys.argv[7]) if len(sys.argv)>7 else {}
kill_after=float(opts.get('killAfter') or 0); resend=bool(opts.get('resend')); diagnostics=bool(opts.get('diagnostics'))
pid,fd=pty.fork()
if pid==0:
 os.chdir(sys.argv[1]); os.execvpe(sys.argv[2],[sys.argv[2],sys.argv[3]]+argv,os.environ)
out=b''; checkpoint=0; action=0; resends=0; started=time.time(); end=started+timeout
done_at=None; last_send=None; last_sent_at=0; stall_resends=0; last_resend=0
while time.time()<end:
 r,_,_=select.select([fd],[],[],0.1)
 if r:
  try: out+=os.read(fd,65536)
  except OSError:
   _,status=os.waitpid(pid,0); print(out.decode('utf-8','replace')); sys.exit(os.waitstatus_to_exitcode(status))
 ready=False
 if action<len(actions):
  a=actions[action]
  if a.get('waitFile'): ready=os.path.exists(a['waitFile'])
  elif a.get('wait') and a['wait'].encode() in out[checkpoint:]: ready=True
 if ready:
  time.sleep(.15); s=actions[action].get('send') or ''
  if s: os.write(fd,s.encode())
  last_send=s.encode() if s else None; last_sent_at=time.time(); stall_resends=0
  w=actions[action].get('wait')
  checkpoint=(out.index(w.encode(),checkpoint)+len(w.encode())) if w else len(out)
  action+=1
  if action==len(actions) and kill_after>0: done_at=time.time()+kill_after
 elif resend and action<len(actions) and last_send and stall_resends<1 and time.time()-last_sent_at>5:
  os.write(fd,last_send); last_sent_at=time.time(); stall_resends=1
 elif resend and action==len(actions) and actions and resends<15 and time.time()-last_resend>2 and actions[-1].get('send'):
  try: os.write(fd,actions[-1]['send'].encode())
  except OSError: pass
  resends+=1; last_resend=time.time()
 if done_at and time.time()>done_at:
  os.kill(pid,15); print(out.decode('utf-8','replace')); sys.exit(0)
 p,status=os.waitpid(pid,os.WNOHANG)
 if p:
  print(out.decode('utf-8','replace')); sys.exit(os.waitstatus_to_exitcode(status) if action==len(actions) else 125)
elapsed=time.time()-started
progress_captured=False
if diagnostics:
 os.write(3,b'timeout')
 ready,_,_=select.select([0],[],[],1)
 progress_captured=bool(ready and os.read(0,1)==b'1')
os.kill(pid,15)
cleanup_end=time.time()+1
while True:
 p,status=os.waitpid(pid,os.WNOHANG)
 if p: break
 if time.time()>=cleanup_end:
  os.kill(pid,9); os.waitpid(pid,0); break
 time.sleep(.01)
if diagnostics:
 a=actions[action] if action<len(actions) else {}
 print('PTY_TIMEOUT '+json.dumps(dict(action=action,totalActions=len(actions),expected=a.get('waitFile') or a.get('wait') or '<process exit>',elapsedSec=round(elapsed,3),progressCaptured=progress_captured,tail=out.decode('utf-8','replace'))))
else:
 print(out.decode('utf-8','replace'))
sys.exit(124)`;

export interface PtyResult {
  code: number | null;
  output: string;
  /** Snapshot captured on the timeout path when `diagnostics` is on. */
  timeoutProgress?: Record<string, number>;
}

export function runPty(cwd: string, args: string[], env: NodeJS.ProcessEnv, actions: PtyAction[], options: PtyOptions = {}): Promise<PtyResult> {
  const { timeoutSec = 60, cliPath = defaultCliPath, killAfterLastActionSec, diagnostics = false, resend = false, onTimeoutProgress } = options;
  const flags = JSON.stringify({ killAfter: killAfterLastActionSec ?? 0, resend, diagnostics });
  return new Promise((done) => {
    const child = spawn("python3", ["-c", python, cwd, process.execPath, cliPath, JSON.stringify(actions), JSON.stringify(args), String(timeoutSec), flags], { env, stdio: ["pipe", "pipe", "pipe", "pipe"] });
    let timeoutProgress: Record<string, number> | undefined;
    // Dedicated pipe avoids mixing the handshake with terminal content or credentials.
    if (diagnostics) {
      child.stdio[3]!.once("data", () => {
        timeoutProgress = onTimeoutProgress?.();
        child.stdin!.end("1");
      });
      // The bounded Python handshake may expire first; a closed pipe is best-effort.
      child.stdin!.on("error", () => {});
    }
    let output = "";
    child.stdout!.on("data", (chunk) => output += chunk);
    child.stderr!.on("data", (chunk) => output += chunk);
    // The timeout diagnostic is formatted and sanitised by the caller: this module
    // only knows the raw output and the progress snapshot.
    child.on("close", (code) => done({ code, output, ...(timeoutProgress ? { timeoutProgress } : {}) }));
  });
}
