import { spawn, type ChildProcess } from "node:child_process";
import { openSync, closeSync, readSync, statSync, mkdirSync } from "node:fs";
import path from "node:path";
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
  stdoutPath: string;
  stderrPath: string;
  stdoutOffset: number; // poll() 已读到的字节偏移,增量读取用
  stderrOffset: number;
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

// 读文件里 [offset, EOF) 这一段新增内容;文件还不存在(比如 child 还没来得及第一次写)当空串处理。
function readNewBytes(filePath: string, offset: number): { text: string; newOffset: number } {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return { text: "", newOffset: offset };
  }
  if (size <= offset) return { text: "", newOffset: offset };
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    return { text: buf.toString("utf8"), newOffset: size };
  } finally {
    closeSync(fd);
  }
}

class ProcessManager {
  private procs = new Map<string, BgProc>();
  private counter = 0;

  start(command: string, cwd: string): string {
    const id = `proc-${++this.counter}`;
    const logDir = path.join(cwd, ".dao", "bg", id);
    mkdirSync(logDir, { recursive: true });
    const stdoutPath = path.join(logDir, "stdout.log");
    const stderrPath = path.join(logDir, "stderr.log");
    // 关键:stdio 落文件而不是 pipe。pipe 的另一头连着 DAO 自己这个进程,DAO 退出时 pipe 被关闭,
    // 子进程下次往 stdout/stderr 写东西就会收到 SIGPIPE(默认行为是终止)——这正是"DAO 自己测的时候
    // 服务还活着、退出后再连就没了"的真实成因,不是被谁显式杀掉的。落文件 + unref() 才是真正独立于
    // DAO 自身进程生命周期的后台执行,DAO 退出后子进程能继续跑、日志也能持续写。
    const outFd = openSync(stdoutPath, "a");
    const errFd = openSync(stderrPath, "a");
    const sb = sandboxSpawn(command, cwd); // S4 沙箱(启用时)
    const child = sb && !("error" in sb)
      ? spawn(sb.file, sb.args, { cwd, detached: true, stdio: ["ignore", outFd, errFd], env: scrubbedEnv() })
      : spawn(command, { cwd, shell: true, detached: true, stdio: ["ignore", outFd, errFd], env: scrubbedEnv() }); // S5.2 env 脱敏
    closeSync(outFd);
    closeSync(errFd); // spawn 内部已 dup,父进程这两个 fd 用不上了,不关会泄漏
    child.unref(); // 不让这个子进程的存在阻塞/牵制 DAO 自身进程退出
    const proc: BgProc = {
      id,
      command,
      child,
      stdoutPath,
      stderrPath,
      stdoutOffset: 0,
      stderrOffset: 0,
      status: "running",
      exitCode: null,
      signal: null,
    };
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
    const out = readNewBytes(p.stdoutPath, p.stdoutOffset);
    const err = readNewBytes(p.stderrPath, p.stderrOffset);
    p.stdoutOffset = out.newOffset;
    p.stderrOffset = err.newOffset;
    return {
      status: p.status,
      stdout: out.text,
      stderr: err.text,
      exitCode: p.exitCode,
      signal: p.signal,
    };
  }

  kill(id: string): void {
    const p = this.procs.get(id);
    if (!p) throw new Error(`未知后台进程:${id}`);
    killTree(p.child, "SIGTERM");
  }

  runningCount(): number {
    let n = 0;
    for (const p of this.procs.values()) if (p.status === "running") n++;
    return n;
  }

  reset(): void {
    for (const p of this.procs.values()) killTree(p.child, "SIGKILL");
    this.procs.clear();
    this.counter = 0;
  }
}

export const processManager = new ProcessManager();
