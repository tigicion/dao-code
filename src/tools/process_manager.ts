import { spawn, type ChildProcess } from "node:child_process";

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
    const child = spawn(command, { cwd, shell: true });
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
    p.child.kill("SIGTERM");
  }

  reset(): void {
    for (const p of this.procs.values()) p.child.kill("SIGKILL");
    this.procs.clear();
    this.counter = 0;
  }
}

export const processManager = new ProcessManager();
