import { spawn, exec, type ChildProcess } from "node:child_process";
import { openSync, closeSync, readSync, statSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { scrubbedEnv } from "./safe_env.js";
import { sandboxSpawn } from "./sandbox.js";
import { PKG_MGR_TIMEOUT_RE } from "./pkg_mgr_pattern.js";

const execAsync = promisify(exec);

// 包管理器命令(apt-get/apt/dpkg/aptitude)被后台 KillShell 打断,和 exec_shell.ts 里前台
// abort 打断是同一个根因:dpkg 事务被留在半途(interrupted 态),不自动恢复的话这个损坏会
// 悄悄传染到本次会话之后所有包管理操作,甚至连累到 verifier 自己要装的东西(真实撞见:
// pytorch-model-cli,模型后台起了两次 apt-get install gcc、KillShell 杀掉其中一个,dpkg
// 锁没释放,验收阶段自己装 curl/uv 全部失败)。exec_shell.ts 的前台 abort 分支已经有这段
// 恢复逻辑,但 KillShell 走的是完全独立的代码路径,原来没覆盖到。
async function attemptDpkgRecovery(): Promise<{ ok: boolean; stderr: string }> {
  const tryOnce = async (): Promise<{ ok: boolean; stderr: string }> => {
    try {
      await execAsync("dpkg --configure -a");
      return { ok: true, stderr: "" };
    } catch (e) {
      const stderr = e && typeof e === "object" && "stderr" in e ? String((e as { stderr: unknown }).stderr) : String(e);
      return { ok: false, stderr };
    }
  };
  let result = await tryOnce();
  if (!result.ok) {
    // 刚被杀掉的包管理器进程可能还没来得及释放 dpkg 锁,恢复命令撞了个空;
    // 等一小段时间再试一次,dpkg --configure -a 本身幂等安全,重试不会有副作用。
    await new Promise((resolve) => setTimeout(resolve, 2000));
    result = await tryOnce();
  }
  return result;
}

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
  notified: boolean; // 进程退出时已入队通知(防 poll/KillShell 重复入队)
}

export interface PollResult {
  status: "running" | "exited";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
}

// 后台 shell 完成通知(与子代理的 <task-notification> 同构,复用主循环的 drainNotifications 通路)。
function shellNotificationXml(id: string, command: string, exitCode: number | null, signal: string | null): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const status = exitCode === 0 ? "completed" : "failed";
  const detail = exitCode !== null ? `exit code ${exitCode}` : `signal ${signal ?? "unknown"}`;
  return [
    `<task-notification>`,
    `<task-id>${id}</task-id>`,
    `<description>${esc(command)}</description>`,
    `<status>${status}</status>`,
    `<result>后台命令 "${esc(command)}" 已结束(${detail})。用 BashOutput 查看完整输出。</result>`,
    `</task-notification>`,
  ].join("\n");
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
  private notifications: string[] = [];
  private onChangeCb: (() => void) | undefined;
  private notify = () => this.onChangeCb?.();

  onChange(cb: () => void): void { this.onChangeCb = cb; }
  drainNotifications(): string[] { return this.notifications.splice(0); }
  hasShellNotifications(): boolean { return this.notifications.length > 0; }

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
      notified: false,
    };
    child.on("exit", (code, signal) => {
      proc.status = "exited";
      proc.exitCode = code;
      proc.signal = signal;
      // 进程退出时自动入队通知 -- 模型在下一个回合边界收到,不需要手动轮询。
      // notified 标记防止 poll()/kill() 路径二次入队同一个退出事件。
      if (!proc.notified) {
        proc.notified = true;
        this.notifications.push(shellNotificationXml(id, command, code, signal));
        this.notify();
      }
    });
    this.procs.set(id, proc);
    return id;
  }

  // 接管一个【已经在跑】的前台子进程(不是自己 spawn 的)—— Ctrl+B 转后台用。
  // 前台路径(exec_shell.ts runForeground)用 pipe 收集输出到内存字符串,跟 start() 的落文件方式不同;
  // 这里做一次性引导写入(把接管前已经攒下的 buffered 内容写进文件)+ 后续增量追加到同一批文件,
  // 这样接管完成后这个进程在 poll()/kill()/退出通知上跟 start() 建的进程完全同构,不用改那些逻辑。
  adopt(child: ChildProcess, command: string, cwd: string, buffered: { stdout: string; stderr: string }): string {
    const id = `proc-${++this.counter}`;
    const logDir = path.join(cwd, ".dao", "bg", id);
    mkdirSync(logDir, { recursive: true });
    const stdoutPath = path.join(logDir, "stdout.log");
    const stderrPath = path.join(logDir, "stderr.log");
    // 引导写入:接管前已经产出、只存在于调用方内存里的那部分输出,先落盘,不然这部分内容永久丢失。
    writeFileSync(stdoutPath, buffered.stdout);
    writeFileSync(stderrPath, buffered.stderr);
    const proc: BgProc = {
      id, command, child, stdoutPath, stderrPath,
      // offset 从 0 开始,不是引导内容的字节长度:接管前的输出只存在于调用方内存里,没人通过
      // BashOutput 读过它——第一次 poll() 就该把引导内容 + 后续新增内容一起读到,不能让它凭空消失。
      stdoutOffset: 0,
      stderrOffset: 0,
      status: "running",
      exitCode: null,
      signal: null,
      notified: false,
    };
    // 接管后的新增输出:直接追加写文件(调用方在过继前应该已经摘掉自己的 "data" 监听器,
    // 见 exec_shell.ts 的过继逻辑;这里只管接手之后的部分,不关心过继前谁在监听)。
    child.stdout?.on("data", (d: Buffer) => appendFileSync(stdoutPath, d));
    child.stderr?.on("data", (d: Buffer) => appendFileSync(stderrPath, d));
    child.on("exit", (code, signal) => {
      proc.status = "exited";
      proc.exitCode = code;
      proc.signal = signal;
      if (!proc.notified) {
        proc.notified = true;
        this.notifications.push(shellNotificationXml(id, command, code, signal));
        this.notify();
      }
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

  // 返回值:非包管理器命令时 resolve undefined;包管理器命令时 resolve 一段恢复结果说明
  // (成功/失败都有文案,供 KillShell 工具的返回值里附带告知模型)。未知 id 仍然是同步抛错——
  // 不是 async function,throw 发生在返回 Promise 之前,调用方 expect(() => kill(...)).toThrow()
  // 这类同步断言不受影响。
  kill(id: string): Promise<string | undefined> {
    const p = this.procs.get(id);
    if (!p) throw new Error(`未知后台进程:${id}`);
    killTree(p.child, "SIGTERM");
    if (!PKG_MGR_TIMEOUT_RE.test(p.command)) return Promise.resolve(undefined);
    return attemptDpkgRecovery().then((fix) =>
      fix.ok
        ? "[自动恢复] 检测到后台包管理器命令被终止,已跑 `dpkg --configure -a` 修复 dpkg 状态,可以重试。"
        : `[自动恢复失败] 检测到后台包管理器命令被终止,尝试 \`dpkg --configure -a\` 修复但仍失败(已重试1次)——继续前建议手动确认 dpkg 状态。${fix.stderr.trim() ? `\n[恢复命令输出]\n${fix.stderr.trim()}` : ""}`,
    );
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
    this.notifications = [];
  }
}

export const processManager = new ProcessManager();
