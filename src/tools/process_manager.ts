import { spawn, type ChildProcess } from "node:child_process";
import { scrubbedEnv } from "./safe_env.js";
import { sandboxSpawn } from "./sandbox.js";

// 杀整个进程组(detached 下 child 是组长,-pid 杀它及其 shell 派生的所有孙进程,避免孤儿)。
function killTree(child: ChildProcess, sig: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    try { child.kill(sig); } catch {}
  }
}

interface BgProc {
  id: string;
  command: string;
  child: ChildProcess;
  stdout: string;
  stderr: string;
  status: "running" | "exited";
  exitCode: number | null;
  signal: string | null;
}

export interface PollResult {
  status: "running" | "exited";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
}

class ProcessManager {
  private procs = new Map<string, BgProc>();
  private counter = 0;

  start(command: string, cwd: string): string {
    const id = `proc-${++this.counter}`;
    const sb = sandboxSpawn(command, cwd); // S4 沙箱(启用时)
    const child = sb && !("error" in sb)
      ? spawn(sb.file, sb.args, { cwd, detached: true, env: scrubbedEnv() })
      : spawn(command, { cwd, shell: true, detached: true, env: scrubbedEnv() }); // S5.2 env 脱敏
    const proc: BgProc = {
      id,
      command,
      child,
      stdout: "",
      stderr: "",
      status: "running",
      exitCode: null,
      signal: null,
    };
    child.stdout?.on("data", (d: Buffer) => {
      proc.stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      proc.stderr += d.toString();
    });
    child.on("exit", (code, signal) => {
      proc.status = "exited";
      proc.exitCode = code;
      proc.signal = signal;
    });
    this.procs.set(id, proc);
    return id;
  }

  poll(id: string): PollResult {
    const p = this.procs.get(id);
    if (!p) throw new Error(`未知后台进程:${id}`);
    const out: PollResult = {
      status: p.status,
      stdout: p.stdout,
      stderr: p.stderr,
      exitCode: p.exitCode,
      signal: p.signal,
    };
    p.stdout = "";
    p.stderr = "";
    return out;
  }

  kill(id: string): void {
    const p = this.procs.get(id);
    if (!p) throw new Error(`未知后台进程:${id}`);
    killTree(p.child, "SIGTERM");
  }

  reset(): void {
    for (const p of this.procs.values()) killTree(p.child, "SIGKILL");
    this.procs.clear();
    this.counter = 0;
  }
}

export const processManager = new ProcessManager();
