import { spawn } from "node:child_process";
import { z } from "zod";
import { defineTool } from "./types.js";
import { processManager } from "./process_manager.js";
import { spillOutput } from "./spill.js";
import { isDangerousCommand } from "../permissions/bash_safety.js";
import { hasSuspiciousUnicode } from "../permissions/sanitize.js";
import { scrubbedEnv } from "./safe_env.js";
import { sandboxSpawn } from "./sandbox.js";

interface ForegroundResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
  aborted: boolean;
}

const OUT_CAP = 10 * 1024 * 1024; // 内存中累积输出上限,超出截断(防 OOM)
// 包管理器命令的粗粒度识别:命令名前后是空白/分隔符/行首,不匹配文件名里带这几个词的情况
// (跟 permissions/bash_safety.ts 里 cmdRe() 的边界判断同一个思路,避免 \b 的同形字/文件名假阳性)。
const PKG_MGR_TIMEOUT_RE = /(?:^|[\s;&|])(apt-get|apt|dpkg|aptitude)(?=\s|$|;|&|\|)/;

function runForeground(
  command: string,
  cwd: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<ForegroundResult> {
  return new Promise((resolve) => {
    // 用 spawn + detached(进程组)+ 杀整组:exec/kill 只杀 shell,Linux 下子进程(如 sleep)会存活,
    // 导致 ESC/超时无法真正中断前台命令。杀进程组才能连同 shell 的所有孙进程一起结束。
    let aborted = false;
    let timedOut = false;
    let done = false;
    let stdout = "";
    let stderr = "";
    let capped = false;
    // S4 沙箱:启用则裹进 Seatbelt/bubblewrap(工作区可写、其余只读);未启用照常 shell 执行。
    const sb = sandboxSpawn(command, cwd);
    if (sb && "error" in sb) { resolve({ stdout: "", stderr: `沙箱不可用:${sb.error}`, code: 1, aborted: false, timedOut: false }); return; }
    const child = sb
      ? spawn(sb.file, sb.args, { cwd, detached: true, env: scrubbedEnv() })
      : spawn(command, { cwd, shell: true, detached: true, env: scrubbedEnv() }); // S5.2 env 脱敏
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try { child.kill(sig); } catch {}
      }
    };
    const append = (buf: Buffer, which: "o" | "e") => {
      if (capped) return;
      const s = buf.toString();
      if (which === "o") stdout += s; else stderr += s;
      if (stdout.length + stderr.length > OUT_CAP) { capped = true; killGroup("SIGTERM"); }
    };
    child.stdout?.on("data", (d: Buffer) => append(d, "o"));
    child.stderr?.on("data", (d: Buffer) => append(d, "e"));
    const timer = setTimeout(() => { timedOut = true; killGroup("SIGTERM"); }, timeout);
    function onAbort() { aborted = true; killGroup("SIGTERM"); }
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    let exitGraceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (exitGraceTimer) clearTimeout(exitGraceTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (capped) stderr += "\n[输出超过 10MB 上限被截断,请用更精确的命令或重定向到文件后再 grep/read_file]";
      resolve({ stdout, stderr, code, timedOut, aborted });
    };
    // "close" 要等 stdio 流全部看到 EOF 才触发——如果命令拉起了一个没把 stdout/stderr 重定向
    // 走(继承了父进程管道)的后台服务(比如 init 脚本式的 `xxx start`),服务只要还活着就一直
    // 占着管道不放,"close" 就永远不会来,即便超时/SIGTERM 已经正确杀掉了能杀到的那部分进程组,
    // Promise 也会永久卡住、超时机制形同虚设。真实撞见过(terminal-bench mailman 任务,启动
    // postfix/mailman3 服务后 exec_shell 卡死超过1500秒,直到外层 harbor 硬超时才被杀)。
    // 用 Node 实测验证过:同一个子进程,"exit"(进程自己退出)几乎立刻触发,"close"(stdio 流
    // 关闭)要等占着管道的孤儿进程自己退出才触发,如果那个孤儿进程是长期运行的服务,永远等不到。
    // 修法:改成以"exit"为准——它代表命令本身真的跑完了,不该被"某个继承了 fd 的孙进程还活着"
    // 卡住;"exit"后短暂等一小段时间(处理数据事件的正常异步延迟),等不到"close"就用已攒到的
    // 输出收尾,不再无限等。
    let exitCode: number | null = null;
    child.on("error", (e) => { stderr += String((e as Error).message ?? e); finish(1); });
    child.on("close", (code) => finish(typeof code === "number" ? code : (exitCode ?? 1)));
    child.on("exit", (code) => {
      exitCode = typeof code === "number" ? code : 1;
      exitGraceTimer = setTimeout(() => finish(exitCode!), 300);
    });
  });
}

export const execShellTool = defineTool({
  name: "exec_shell",
  description:
    "在工作区目录执行 shell 命令(git、跑测试、npm/pip 等构建工具都走它)。前台执行等到命令结束,返回 stdout/stderr" +
    "和退出码/超时/中断状态;background=true 立即返回进程 id 不阻塞(适合起个服务、跑个长任务),用 exec_shell_poll" +
    "读它自上次轮询以来的新输出、exec_shell_kill 结束它——别对同一命令又前台等又后台起。background=true 启动的" +
    "是真正独立于 DAO 自身进程存活的后台进程,不会随这次调用结束而自动消失——只在确实需要它持续跑着(起服务、" +
    "长时间任务)时才用,命令本身很快就能跑完就别用后台;不再需要时记得 exec_shell_kill 收尾,除非任务本身就要求" +
    "这个服务保持运行(比如要求'启动并保持在后台运行'的服务类任务,这种就应该让它继续跑,不用主动杀)。" +
    "前台默认超时 120 秒,可用" +
    "timeout(毫秒)调;超时或中断都会杀掉整个进程组(不只是 shell 本身,命令里再拉起的子进程也一起终止)。" +
    "输出在内存里最多攒 10MB,超了会截断并提示改用更精确的命令或重定向到文件后再查——命令本身别指望它能把一个几十MB" +
    "的输出原样倒给你。\n" +
    "查文件内容用 grep_files、查文件名/路径用 file_search、读文件用 read_file——不要用本工具拼 grep/rg/find/cat/head/tail," +
    "专用工具有护栏(大小限制、二进制探测)且不占审批。\n" +
    "高风险命令(rm -rf /、curl|sh 直接执行远程脚本、提权、写裸盘设备等)即便审批规则整体放宽了,也会被强制要求" +
    "确认一次,绕不过去;命令里混了同形字符/零宽字符伪装成正常样子也会被拦下强制确认。\n" +
    "在还没搞清楚一份数据/文件的状态就去探查它时要留神:某些'看起来是只读查询'的命令其实有副作用" +
    "(比如对 SQLite 数据库跑查询可能触发 WAL checkpoint、直接消耗掉本该保留的 WAL 文件;某些工具打开文件" +
    "时会自动修复/重写它)。任务是要恢复/修复某份可能损坏的原始数据时,先复制一份再动手探查,不要直接在" +
    "唯一的原始文件上试——探查途中不可逆地毁掉本来能验证假设的原始证据,比多花一步复制的成本高得多。",
  descriptionEn:
    "Executes a shell command in the workspace directory (git, running tests, build tools like npm/pip). Foreground execution waits for completion and returns stdout/stderr " +
    "plus exit code / timeout / abort status; background=true returns a process id immediately without blocking (good for starting a service or a long task) — use " +
    "exec_shell_poll to read its new output since the last poll, exec_shell_kill to stop it. Don't both wait in foreground and also start the same command in background. " +
    "A background=true process is genuinely independent of DAO's own process lifetime — it does NOT vanish just because this call returns. Only reach for it when " +
    "something actually needs to keep running (a service, a long task) — not for commands that will finish quickly anyway. Remember to exec_shell_kill it once it's " +
    "no longer needed, unless the task itself requires the service to keep running (e.g. a task asking you to 'start and keep it running in the background' — leave " +
    "that one up, don't kill it). " +
    "Foreground defaults to a 120s timeout, adjustable via timeout (ms); both a timeout and an abort kill the entire process group, not just the shell — " +
    "child processes spawned by the command are terminated too. Output is capped at 10MB in memory; past that it's truncated with a hint to use a more precise " +
    "command or redirect to a file and inspect that instead — don't expect a raw multi-MB output to come back intact.\n" +
    "Use grep_files for content search, file_search for filename/path search, read_file for reading files — do not shell out to grep/rg/find/cat/head/tail; the dedicated " +
    "tools have guardrails (size limits, binary detection) and skip approval.\n" +
    "High-risk commands (rm -rf /, piping curl straight into a shell, privilege escalation, writing raw disk devices, etc.) force a confirmation even if approval rules " +
    "are otherwise relaxed — there's no way around it; commands disguised with homoglyph/zero-width characters are likewise forced to confirm.\n" +
    "Be careful when probing a file/dataset whose state you don't fully understand yet: some commands that look read-only actually have side effects " +
    "(e.g. querying a SQLite database can trigger a WAL checkpoint that consumes the very WAL file you needed to preserve; some tools auto-repair/rewrite " +
    "a file just by opening it). When the task is to recover/repair a possibly-corrupted original file, copy it first before probing — irreversibly " +
    "destroying the original evidence mid-investigation costs far more than the one extra copy step.",
  capability: "exec",
  approval: "required",
  schema: z.object({
    command: z.string().describe("要执行的 shell 命令"),
    background: z.boolean().optional().describe("是否后台运行(长任务/服务)"),
    timeout: z.number().int().min(1).optional().describe("前台超时(毫秒),默认 120000"),
  }),
  // 参数级自检:危险命令(rm -rf /、curl|sh、提权、写裸盘…)→ 强制确认,即便有放宽规则放行
  // (checkPermissions 只能收紧)。完整黑名单见 permissions/bash_safety.ts。
  checkPermissions: (argsJson) => {
    try {
      const { command } = JSON.parse(argsJson) as { command?: string };
      if (typeof command === "string" && (isDangerousCommand(command) || hasSuspiciousUnicode(command))) return "ask"; // S1.1 同形/零宽伪装也强制确认
    } catch { /* 参数未成形 */ }
    return null;
  },
  handler: async (args, ctx) => {
    if (args.background) {
      const id = processManager.start(args.command, ctx.workspaceRoot);
      return `已在后台启动(id=${id})。用 exec_shell_poll 读取输出,exec_shell_kill 结束。`;
    }
    const r = await runForeground(args.command, ctx.workspaceRoot, args.timeout ?? 120000, ctx.signal);
    const parts: string[] = [];
    if (r.stdout.trim()) parts.push(r.stdout.trimEnd());
    if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
    parts.push(r.aborted ? `[已中断]` : r.timedOut ? `[超时,已终止]` : `[exit ${r.code}]`);
    // 包管理器命令(apt-get/apt/dpkg)被超时打断,可能把 dpkg 事务留在半途(interrupted 态)——
    // 不自动恢复的话,这个损坏会悄悄传染到本次会话之后所有包管理操作,甚至连累到别处
    // (真实撞见:merge-diff-arc-agi-task 任务,算法本身完全正确,纯因为早先一次 apt-get
    // 被 120s 超时强杀在事务中途、dpkg 卡在 interrupted 态,导致 verifier 自己装 curl/uv 也
    // 失败、pytest 从未跑起来,判了 0 分——这是第2次独立复现同一个具体机制,不是孤立事件)。
    // 只在"我们自己的超时"打断时才自动修(不含用户主动 abort,那种不该附加额外动作);
    // 用 dpkg --configure -a 这个幂等、安全的标准恢复命令,失败也不影响本次调用正常返回。
    if (r.timedOut && PKG_MGR_TIMEOUT_RE.test(args.command)) {
      const fix = await runForeground("dpkg --configure -a", ctx.workspaceRoot, 30000);
      parts.push(
        fix.code === 0
          ? "[自动恢复] 检测到包管理器命令被超时打断,已跑 `dpkg --configure -a` 修复 dpkg 状态,可以重试。"
          : "[自动恢复失败] 检测到包管理器命令被超时打断,尝试 `dpkg --configure -a` 修复但仍失败——继续前建议手动确认 dpkg 状态。",
      );
    }
    return spillOutput(parts.join("\n"), ctx.workspaceRoot);
  },
});
