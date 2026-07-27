import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync, copyFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "./types.js";
import { processManager } from "./process_manager.js";
import { spillOutput } from "./spill.js";
import { isDangerousCommand } from "../permissions/bash_safety.js";
import { hasSuspiciousUnicode } from "../permissions/sanitize.js";
import { scrubbedEnv } from "./safe_env.js";
import { sandboxSpawn } from "./sandbox.js";
import { walkFiles } from "./walk.js";
import type { ForegroundRegistry } from "../tui/foreground_registry.js";

interface ForegroundResult {
  stdout: string;
  stderr: string;
  code: number;
  aborted: boolean;
  elapsedMs: number;
  // true = 这不是命令真的跑完了,是用户按 Ctrl+B 转后台——handler 要用一条干净的"已转后台"
  // 文案直接返回,不走 exit code/运行时长那套前台专属的拼接逻辑。
  converted?: boolean;
}

const OUT_CAP = 10 * 1024 * 1024; // 内存中累积输出上限,超出截断(防 OOM)
// 包管理器命令的粗粒度识别:命令名前后是空白/分隔符/行首,不匹配文件名里带这几个词的情况
// (跟 permissions/bash_safety.ts 里 cmdRe() 的边界判断同一个思路,避免 \b 的同形字/文件名假阳性)。
const PKG_MGR_TIMEOUT_RE = /(?:^|[\s;&|])(apt-get|apt|dpkg|aptitude)(?=\s|$|;|&|\|)/;
// python3 -c/python -c 内联脚本识别:一次性文本/日志分析动不动就现写 python 脚本,是观测到的
// 真实反模式(session 20260719-194639-mal7 里翻 evolution-log.md 找从未通过的题目,连续 20 次
// Bash 拼 grep/sed;分析自己的 session 日志又连续 10 次 python3 -c——而且事后核对,那 10 次里
// 涉及的文件全部 <20KB,一次 Read 就能读完,没有一次真的需要脚本)。两层拦截:
// 1) 命令里能提取出一个"存在且不大"的文件路径 → 直接第一次就拦,不等它攒够次数;
// 2) 提取不到路径(纯计算、走 stdin 等)时退回"连续出现"计数,≥3 次才提醒一次,避免
//    偶尔一次正当的 JSON/结构化解析(Grep 做不到)也被念叨。
const PYTHON_INLINE_RE = /(?:^|[\s;&|])python3?\s+-c\b/;
// 粗略识别命令里提到的、看起来像数据/文本文件的路径(带引号或裸词,以常见文本类扩展名结尾)。
const FILE_PATH_RE = /(['"]?)([.\w/][\w./-]*\.(?:jsonl?|md|txt|log|csv|ya?ml|toml|ini|tsv))\1/g;
// 门槛跟 Read 工具自己的默认单次读取上限(2000 行)对齐:没必要为了精确算行数先整份读进内存,
// 常见文本行密度下 200KB 大致对应几千行量级,用字节数打个粗略折算够用了。
const SMALL_FILE_BYTES = 200 * 1024;

function findSmallReferencedFile(command: string, cwd: string): { rel: string; bytes: number } | null {
  const re = new RegExp(FILE_PATH_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) {
    const rel = m[2]!;
    const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
    try {
      const st = statSync(abs);
      if (st.isFile() && st.size <= SMALL_FILE_BYTES) return { rel, bytes: st.size };
    } catch { /* 路径解析失败或文件不存在,不是本次拦截的目标,试下一个候选 */ }
  }
  return null;
}

// 粗略识别命令里提到的、看起来像数据库主文件的路径(带引号或裸词,以常见数据库扩展名结尾)。
// 真实撞见(db-wal-recovery 复测,2026-07-27):模型对可能已损坏的数据库跑 `sqlite3.connect()`
// 这类"看起来只读"的查询,SQLite 自己检测到 WAL 校验不过就把 WAL 文件删了,原始证据从此
// 不可逆丢失——之前只在工具描述里加过一句"先备份再探查"的文字提示(c122b8a),但这条提示
// 只是软性建议、不是硬约束,同一天(iteration 12)和这次复测都验证过模型不一定会想起来照做。
// 改成硬约束:命令里引用了数据库主文件,就在真正执行前自动备份它和它的 WAL/SHM/journal
// 边车文件(哪怕命令文本里没有直接提到这些边车文件——它们正是最容易被隐式改写/删除的那批,
// 例:命令只写了 `main.db`,但真正会被 SQLite 静默消耗掉的是 `main.db-wal`)。零阻塞、
// 零额外确认——备份只是多一份磁盘拷贝,不会误伤任何正当操作,唯一的成本是极少量的磁盘空间。
// 扩展名不止 SQLite:同样"打开/修复即可能被引擎自动改写"的单文件存储还有 Redis(.rdb/.aof——
// `redis-check-aof --fix` 这类修复命令会把 AOF 原地截断到最后一条完整命令)、Firebird/
// Interbase(.fdb/.gdb)、KeePass(.kdbx)、dBase/FoxPro(.dbf)。挂载镜像(mount 不带
// `-o ro`)、git 历史取证(gc/prune 清掉悬空对象)这类不是靠文件后缀识别的场景暂不在此列,
// 需要按命令名单独判断,和这里的"认后缀"机制不同构,留给以后有真实场景撞见时再单独设计。
// 扩展名后缀加 (?![\w]) 边界:纯 "db" 是 "db3"/"dbf" 的前缀,alternation 按列出顺序匹配、
// 不是按最长匹配优先——不加这个边界的话 "table.dbf" 会被 "db" 抢先截断匹配掉,吞掉合法的
// "f" 尾巴,导致按错误的文件名("table.db")去找文件,实际存在的是"table.dbf"因而找不到。
const DB_MAIN_FILE_RE = /(['"]?)([.\w/][\w./-]*\.(?:db|db3|sqlite3?|mdb|accdb|rdb|aof|fdb|gdb|kdbx|dbf)(?!\w))\1/gi;
const DB_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"];
const DB_BACKUP_SUFFIX = ".dao-backup";

function findUnbackedDbFiles(command: string, cwd: string): { rel: string; abs: string }[] {
  const re = new RegExp(DB_MAIN_FILE_RE.source, "gi");
  const candidates = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) {
    const rel = m[2]!;
    candidates.add(rel);
    for (const suf of DB_SIDECAR_SUFFIXES) candidates.add(rel + suf);
  }
  const out: { rel: string; abs: string }[] = [];
  for (const rel of candidates) {
    const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
    try {
      if (!statSync(abs).isFile()) continue;
    } catch { continue; } // 路径解析失败或文件不存在,不是备份目标
    try {
      statSync(abs + DB_BACKUP_SUFFIX);
      continue; // 已经备份过(哪怕是更早一次调用备份的),不重复覆盖——要保留的是最早的干净版本
    } catch { /* 还没备份过 */ }
    out.push({ rel, abs });
  }
  return out;
}

function backupDbFilesBeforeExec(command: string, cwd: string): string | null {
  const targets = findUnbackedDbFiles(command, cwd);
  if (!targets.length) return null;
  const backed: string[] = [];
  for (const t of targets) {
    try {
      copyFileSync(t.abs, t.abs + DB_BACKUP_SUFFIX);
      backed.push(t.rel);
    } catch { /* 备份本身失败(权限/磁盘满等)不阻断原命令,只是少一层保险 */ }
  }
  if (!backed.length) return null;
  return `[自动备份] 检测到命令涉及数据库文件,已在执行前备份到同名 + ${DB_BACKUP_SUFFIX} 后缀` +
    `(${backed.join("、")})——有些"看起来只读"的操作(如对可能损坏的数据库跑查询)可能被数据库` +
    `引擎自动修复/重写甚至删除原始文件,先备份可以保住能验证假设的原始证据。`;
}

// 会话结束时清理本次运行产生的所有 .dao-backup 文件——它们只是执行过程中的安全网,任务结束后
// 留在工作区没有意义,还可能被判分脚本当成意外多出来的文件。递归扫全部工作区(复用 walkFiles,
// 跳过 node_modules/.git 等常见目录),逐个删除;单个文件删除失败(权限等)不影响其它文件,
// 也不影响会话正常退出。
export async function cleanupDbBackups(workspaceRoot: string): Promise<number> {
  let n = 0;
  for await (const { abs } of walkFiles(workspaceRoot)) {
    if (!abs.endsWith(DB_BACKUP_SUFFIX)) continue;
    try {
      await unlink(abs);
      n++;
    } catch { /* 删除失败不影响会话退出,顶多留一个无害的备份文件 */ }
  }
  return n;
}

// 进程内存活的连续计数(第 2 层兜底用),不跟着 ctx 走(ctx 每次调用都是新对象,存不住跨调用状态)。
let pythonInlineStreak = 0;
let pythonInlineNudged = false;

function runForeground(
  command: string,
  cwd: string,
  signal?: AbortSignal,
  disableSandbox?: boolean,
  headless?: boolean,
  registry?: ForegroundRegistry,
): Promise<ForegroundResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    // 用 spawn + detached(进程组)+ 杀整组:exec/kill 只杀 shell,Linux 下子进程(如 sleep)会存活,
    // 导致 ESC 无法真正中断前台命令。杀进程组才能连同 shell 的所有孙进程一起结束。
    let aborted = false;
    let done = false;
    let stdout = "";
    let stderr = "";
    let capped = false;
    // S4 沙箱:启用则裹进 Seatbelt/bubblewrap(工作区可写、其余只读);未启用照常 shell 执行。
    const sb = sandboxSpawn(command, cwd, disableSandbox);
    if (sb && "error" in sb) { resolve({ stdout: "", stderr: `沙箱不可用:${sb.error}`, code: 1, aborted: false, elapsedMs: 0 }); return; }
    const child = sb
      ? spawn(sb.file, sb.args, { cwd, detached: true, env: scrubbedEnv() })
      : spawn(command, { cwd, shell: true, detached: true, env: scrubbedEnv() }); // S5.2 env 脱敏
    // headless 模式:启动后立即关闭 stdin,防止交互式命令(如 7z 不带 -p)卡在等待输入。
    // 不读 stdin 的命令不受影响;读 stdin 的命令收到 EOF 立即报错退出。
    if (headless) child.stdin?.end();
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
    const onStdout = (d: Buffer) => append(d, "o");
    const onStderr = (d: Buffer) => append(d, "e");
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    function onAbort() { aborted = true; killGroup("SIGTERM"); }
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    let exitGraceTimer: ReturnType<typeof setTimeout> | undefined;
    // Ctrl+B 转后台:注册一个 id + 回调,回合发起方(App.tsx)按键时触发。
    const regId = randomUUID();
    const finish = (code: number) => {
      if (done) return;
      done = true;
      registry?.unregister(regId);
      if (exitGraceTimer) clearTimeout(exitGraceTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (capped) stderr += "\n[输出超过 10MB 上限被截断,请用更精确的命令或重定向到文件后再 grep/Read]";
      resolve({ stdout, stderr, code, aborted, elapsedMs: Date.now() - startTime });
    };
    // "close" 要等 stdio 流全部看到 EOF 才触发——如果命令拉起了一个没把 stdout/stderr 重定向
    // 走(继承了父进程管道)的后台服务(比如 init 脚本式的 `xxx start`),服务只要还活着就一直
    // 占着管道不放,"close" 就永远不会来,即便中断/SIGTERM 已经正确杀掉了能杀到的那部分进程组,
    // Promise 也会永久卡住。真实撞见过(terminal-bench mailman 任务,启动
    // postfix/mailman3 服务后 Bash 卡死超过1500秒,直到外层 harbor 硬超时才被杀)。
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

    registry?.register(regId, () => {
      if (done) return; // 命令恰好在这一瞬间自然结束了,done 标志位保证只 settle 一次
      done = true;
      // 解绑原来的 abort 监听器:过继之后,终止这个进程的唯一入口应该是 KillShell(processManager
      // 生命周期管),不能让这条 ctx.signal 上的旧 onAbort 继续认领"我负责杀它"。
      if (signal) signal.removeEventListener("abort", onAbort);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      const id = processManager.adopt(child, command, cwd, { stdout, stderr });
      resolve({
        stdout: `已转后台(id=${id})。进程完成后会自动通知你——做完别的事后可以用 BashOutput 看一眼进度趋势,发现异常用 KillShell 终止。`,
        stderr: "", code: 0, aborted: false, elapsedMs: Date.now() - startTime, converted: true,
      });
    });
  });
}

export const execShellTool = defineTool({
  name: "Bash",
  description:
    "在工作区目录执行 shell 命令(git、跑测试、npm/pip 等构建工具都走它)。前台执行等到命令结束,返回 stdout/stderr" +
    "和退出码/中断状态;background=true 立即返回进程 id 不阻塞(适合起个服务、跑个长任务)," +
    "进程完成后会自动通知你--不需要轮询,可以去做别的事,结果到了下一个回合自动回灌。" +
    "用 BashOutput 读取中间输出(看进度/查报错),KillShell 结束它--别对同一命令又前台等又后台起。background=true 启动的" +
    "是真正独立于 DAO 自身进程存活的后台进程,不会随这次调用结束而自动消失——只在确实需要它持续跑着(起服务、" +
    "长时间任务)时才用,命令本身很快就能跑完就别用后台;不再需要时记得 KillShell 收尾,除非任务本身就要求" +
    "这个服务保持运行(比如要求'启动并保持在后台运行'的服务类任务,这种就应该让它继续跑,不用主动杀)。" +
    "前台没有超时机制,命令跑到自己退出为止——判断要不要用这个工具等一个命令,责任在你自己:预计会久的" +
    "命令优先走 background(完成后自动通知,不占着前台);真放到前台跑,就是打算等到它自然结束,没有谁会替你" +
    "强行掐断。中断(ESC,仅交互式会话可用)会杀掉整个进程组(不只是 shell 本身,命令里再拉起的子进程也一起" +
    "终止)——但 KillShell 只能停掉已经在后台(background=true 或 Ctrl+B 转后台)的进程,救不了正在前台等待" +
    "中的这次调用本身,所以别指望'等太久了再 KillShell'这种事后补救,前台判断错了就是要等到底。" +
    "输出在内存里最多攒 10MB,超了会截断并提示改用更精确的命令或重定向到文件后再查——命令本身别指望它能把一个几十MB" +
    "的输出原样倒给你。\n" +
    "长耗时命令策略:执行前自判命令是否可能耗时超过 180 秒(npm install、build、test suite、大数据处理等)。" +
    "如果是,优先 background 执行--不只是\"起后台\",而是:做完别的事后用 BashOutput 做 checkpoint 式进度检查," +
    "看输出趋势判断是否正常推进;发现异常(连续报错、长时间无输出、偏离预期)用 KillShell 终止。" +
    "无进度输出但可拆解的命令,拆成小步骤分步跑。都不行再前台跑,让它自然结束——这个分支意味着你已经确认" +
    "它会自己退出,不是在赌一个数字。" +
    "持续关注型场景(如等某条 ERROR 出现)可考虑 Monitor 工具,它主动推送输出;一般 checkpoint 式检查用 BashOutput 即可。\n" +
    "查文件内容用 Grep、查文件名/路径用 Glob、读文件用 Read——不要用本工具拼 grep/rg/find/cat/head/tail," +
    "专用工具有护栏(大小限制、二进制探测)且不占审批。同理,简单文本/日志搜索也别现写 python3 -c 内联脚本模拟" +
    "grep——Grep 工具一次就到位;真需要 JSON/结构化解析等 Grep 做不到的逻辑,优先 Write 成 .py 文件执行,而不是" +
    "在 -c 里反复试错。\n" +
    "高风险命令(rm -rf /、curl|sh 直接执行远程脚本、提权、写裸盘设备等)即便审批规则整体放宽了,也会被强制要求" +
    "确认一次,绕不过去;命令里混了同形字符/零宽字符伪装成正常样子也会被拦下强制确认。\n" +
    "选择命令参数时,思考怎么调用更能解决问题,而不是凭感觉传参数。工具的默认行为(不带额外参数)往往是其设计者" +
    "选择的最优策略;确认掌握了默认行为和参数含义后再决定是否加参数。\n" +
    "例:john hash.txt 不带参数会依次尝试 single -> wordlist -> incremental(按概率从高到低)," +
    "覆盖面最广;直接加 --wordlist=password.lst 反而跳过了 single 和 incremental,把搜索空间收窄到字典里的词。\n" +
    "可选参数:description(命令语义描述,用于审计日志);dangerouslyDisableSandbox(设为 true 绕过 DAO_SANDBOX 沙箱,仅在确认沙箱导致命令失败时使用,会强制审批)。",
  descriptionEn:
    "Executes a shell command in the workspace directory (git, running tests, build tools like npm/pip). Foreground execution waits for completion and returns stdout/stderr " +
    "plus exit code / abort status; background=true returns a process id immediately without blocking (good for starting a service or a long task) - " +
    "you'll be automatically notified when it finishes, so don't poll; go do something else and the result arrives at the next turn boundary. " +
    "Use BashOutput to check intermediate output (progress/errors), KillShell to stop it. Don't both wait in foreground and also start the same command in background. " +
    "A background=true process is genuinely independent of DAO's own process lifetime — it does NOT vanish just because this call returns. Only reach for it when " +
    "something actually needs to keep running (a service, a long task) — not for commands that will finish quickly anyway. Remember to KillShell it once it's " +
    "no longer needed, unless the task itself requires the service to keep running (e.g. a task asking you to 'start and keep it running in the background' — leave " +
    "that one up, don't kill it). " +
    "Foreground has no timeout mechanism at all - the command runs until it exits. Whether this tool is the right way to wait for something is your call: " +
    "a command you expect to be long should go to background (auto-notifies on completion) rather than tying up the foreground on the assumption something " +
    "will cut it off. Abort (ESC, interactive sessions only) kills the entire process group (not just the shell — child processes spawned by the command too) " +
    "— but KillShell only stops processes already in the background (background=true or converted via Ctrl+B); it can't rescue a call that's currently " +
    "blocking in the foreground, so don't count on \"KillShell it if it's taking too long\" as a fallback — a wrong foreground call runs to completion, full stop. " +
    "Output is capped at 10MB in memory; past that it's truncated with a hint to use a more precise " +
    "command or redirect to a file and inspect that instead — don't expect a raw multi-MB output to come back intact.\n" +
    "Long-running command strategy: before executing, judge whether the command may take over 180 seconds (npm install, build, test suite, " +
    "large data processing, etc.). If so, prefer background execution - not just \"start it in background\", but: after doing other work, " +
    "use BashOutput for checkpoint-style progress checks, watching the output trend to judge whether it's advancing normally; if you spot " +
    "anomalies (repeated errors, long silence, diverging from expectation) use KillShell to terminate. For commands " +
    "with no progress output but decomposable, break into smaller steps. If neither works, run foreground and let it finish naturally — reaching this " +
    "branch means you've already concluded it will exit on its own, not that you're betting on a number. " +
    "For continuous-attention scenarios (like waiting for an ERROR line to appear) consider the Monitor tool, which pushes output to you " +
    "proactively; for general checkpoint-style checks, BashOutput suffices.\n" +
    "Use Grep for content search, Glob for filename/path search, Read for reading files — do not shell out to grep/rg/find/cat/head/tail; the dedicated " +
    "tools have guardrails (size limits, binary detection) and skip approval. Likewise, don't write inline python3 -c scripts to reimplement grep for " +
    "simple text/log search — the Grep tool gets there in one shot. For logic Grep genuinely can't do (JSON/structured parsing), prefer Write-ing a helper " +
    "file and running it, rather than trial-and-error inside -c. Use whatever language is actually available in this environment — python is the common " +
    "default, but if it's missing, fall back to node/perl/awk, or even a compiled helper (e.g. a throwaway .c file built with gcc/cc) if that's what's " +
    "present; the goal is automating the repetitive part, not a specific language.\n" +
    "High-risk commands (rm -rf /, piping curl straight into a shell, privilege escalation, writing raw disk devices, etc.) force a confirmation even if approval rules " +
    "are otherwise relaxed - there's no way around it; commands disguised with homoglyph/zero-width characters are likewise forced to confirm.\n" +
    "When choosing command parameters, think about how to invoke the tool to best solve the problem, not just pass parameters by intuition. A tool's default behavior " +
    "(without extra parameters) is often the optimal strategy chosen by its designers; confirm you understand the default behavior and parameter meanings before adding any.\n" +
    "Example: john hash.txt with no parameters tries single -> wordlist -> incremental (in probability order from high to low), covering the widest space; " +
    "adding --wordlist=password.lst skips single and incremental, narrowing the search to only dictionary words.\n" +
    "Optional: description (semantic description of the command, for audit logs); dangerouslyDisableSandbox (set true to bypass DAO_SANDBOX, only when sandbox causes failure, forces approval).",
  capability: "exec",
  approval: "required",
  schema: z.object({
    command: z.string().describe("要执行的 shell 命令"),
    description: z.string().optional().describe("命令的语义描述(用于审计日志,如 'List files in current directory')"),
    background: z.boolean().optional().describe("是否后台运行(长任务/服务)"),
    dangerouslyDisableSandbox: z.boolean().optional().describe("设为 true 绕过沙箱(DAO_SANDBOX=1 时生效);仅在确认沙箱导致命令失败时使用,会强制审批"),
  }),
  // 参数级自检:危险命令(rm -rf /、curl|sh、提权、写裸盘…)→ 强制确认,即便有放宽规则放行
  // (checkPermissions 只能收紧)。完整黑名单见 permissions/bash_safety.ts。
  checkPermissions: (argsJson) => {
    try {
      const parsed = JSON.parse(argsJson) as { command?: string; dangerouslyDisableSandbox?: boolean };
      // 危险命令(rm -rf /、curl|sh、提权、写裸盘…)-> 强制确认,即便有放宽规则放行
      if (typeof parsed.command === "string" && (isDangerousCommand(parsed.command) || hasSuspiciousUnicode(parsed.command))) return "ask";
      // dangerouslyDisableSandbox=true -> 强制审批(绕过沙箱是高风险操作)
      if (parsed.dangerouslyDisableSandbox === true) return "ask";
    } catch { /* 参数未成形 */ }
    return null;
  },
  handler: async (args, ctx) => {
    // 反 sleep 探测:纯 sleep 命令(如 "sleep 15")几乎只用于等待后台任务/进程完成,
    // 这是明确的反模式--后台任务和后台 shell 完成时结果会自动通知,不需要 sleep 等待。
    // 拦截并给出正确指导,而不是让模型白白烧时间。
    // 匹配纯 sleep、以及"sleep N && 后续命令"(复合命令以 sleep 打头,本质是等定时)。
    // 阈值 ≥2 秒(与 CC 对齐):≥2 秒的纯 sleep 几乎没有正当用途,真正需要等就用 background。
    const SLEEP_PREFIX_RE = /^\s*sleep\s+(\d+(?:\.\d+)?)\s*(?:&&|;|\||$)/;
    const sleepMatch = SLEEP_PREFIX_RE.exec(args.command);
    if (sleepMatch) {
      const seconds = parseFloat(sleepMatch[1]!);
      if (seconds >= 2) {
        return `不要用 sleep 阻塞等待。后台 shell(background=true)和后台子代理完成时会自动通知你--` +
          `结束本轮或去做别的事,结果到了自动回灌。\n` +
          `如果你确实需要等待(如等端口可用、等容器启动),用 Bash 的 background 参数起后台命令,` +
          `做完别的事后用 BashOutput 检查进度。\n` +
          `你刚才的命令等了 ${seconds} 秒--这段时间整个 dao 会话被完全阻塞,无法响应用户输入。`;
      }
    }
    if (args.background) {
      // 后台命令一定会真正执行,备份放在这里(不像下面 foreground 分支,还有可能被
      // python-inline 小文件拦截提前返回、命令根本没跑,那种情况不该白白备份一次)。
      const dbBackupNotice = backupDbFilesBeforeExec(args.command, ctx.cwd ?? ctx.workspaceRoot);
      const id = processManager.start(args.command, (ctx.cwd ?? ctx.workspaceRoot));
      const started = `已在后台启动(id=${id})。进程完成后会自动通知你--做完别的事后可以用 BashOutput 看一眼进度趋势,发现异常用 KillShell 终止。不是循环轮询,是 checkpoint 式检查。`;
      return dbBackupNotice ? `${dbBackupNotice}\n${started}` : started;
    }
    const isPythonInline = PYTHON_INLINE_RE.test(args.command);
    if (isPythonInline) {
      // 第 1 层:命令里能认出一个"存在且不大"的文件 → 不等攒够次数,第一次就拦下来不执行,
      // 直接告诉它 Read/Grep 一次到位——这才是"根本上第一次就引导对",而不是纵容它先错3次。
      const small = findSmallReferencedFile(args.command, ctx.cwd ?? ctx.workspaceRoot);
      if (small) {
        return `不用写 python 脚本——${small.rel} 只有 ${(small.bytes / 1024).toFixed(1)}KB,一次 Read 就能读完,` +
          `或用 Grep 定位关键字,都比现写 -c 脚本更快。命令未执行;如果这份数据确实需要脚本才能处理` +
          `(比如要跨多个文件聚合、算法本身复杂),说明理由后可以重新发起。`;
      }
      pythonInlineStreak += 1;
    } else { pythonInlineStreak = 0; pythonInlineNudged = false; }
    // 执行前自动备份命令里涉及的数据库文件(及其 WAL/SHM/journal 边车文件)——硬约束,
    // 不依赖模型记不记得先备份;备份本身不阻塞、不影响命令是否执行,只是多一份磁盘拷贝。
    const dbBackupNotice = backupDbFilesBeforeExec(args.command, ctx.cwd ?? ctx.workspaceRoot);
    const r = await runForeground(args.command, (ctx.cwd ?? ctx.workspaceRoot), ctx.signal, args.dangerouslyDisableSandbox, ctx.headless, ctx.foregroundRegistry);
    if (r.converted) return r.stdout; // Ctrl+B 转后台:干净返回,不走下面 exit code/运行时长的拼接
    const parts: string[] = [];
    if (dbBackupNotice) parts.push(dbBackupNotice);
    if (r.stdout.trim()) parts.push(r.stdout.trimEnd());
    if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
    parts.push(r.aborted ? `[已中断,运行 ${Math.round(r.elapsedMs / 1000)}s]` : `[exit ${r.code},运行 ${Math.round(r.elapsedMs / 1000)}s]`);
    if (isPythonInline && pythonInlineStreak >= 3 && !pythonInlineNudged) {
      pythonInlineNudged = true;
      parts.push(
        `[提示] 连续 ${pythonInlineStreak} 次用 python3 -c 内联脚本做一次性分析——简单文本/日志搜索优先用 Grep` +
        `(支持 context/glob/type,一次到位、不占审批);要通读一份文件再决策,用 Read 一口气读完,别反复换关键词试探;` +
        `确实需要的复杂解析/多步逻辑,Write 成一个 .py 文件再跑,比每次现写现丢更容易复用调试;范围广、要点分散的调查` +
        `可以考虑派 explore 子代理去做。`,
      );
    }
    // 包管理器命令(apt-get/apt/dpkg)被中断打断,可能把 dpkg 事务留在半途(interrupted 态)——
    // 不自动恢复的话,这个损坏会悄悄传染到本次会话之后所有包管理操作,甚至连累到别处
    // (真实撞见:merge-diff-arc-agi-task 任务,算法本身完全正确,纯因为早先一次 apt-get
    // 被前台超时强杀在事务中途、dpkg 卡在 interrupted 态,导致 verifier 自己装 curl/uv 也
    // 失败、pytest 从未跑起来,判了 0 分——这是第2次独立复现同一个具体机制,不是孤立事件)。
    // 触发条件原本是"仅我们自己的超时打断"(显式排除用户主动 abort)——去掉 timeout 机制后,
    // DAO 自己已经不会再主动打断任何前台命令,abort(ESC/信号中断)成了这类命令唯一还会被
    // 打断的途径,所以改成在 abort 时也触发;dpkg --configure -a 本身幂等、安全,多跑一次
    // 不会有副作用,失败也不影响本次调用正常返回。
    if (r.aborted && PKG_MGR_TIMEOUT_RE.test(args.command)) {
      let fix = await runForeground("dpkg --configure -a", (ctx.cwd ?? ctx.workspaceRoot));
      if (fix.code !== 0) {
        // 真实撞见(merge-diff-arc-agi-task 复测):第一次恢复尝试就失败过——猜测是刚被杀掉的
        // 包管理器进程还没来得及释放 dpkg 锁,恢复命令撞了个空。等一小段时间再试一次,
        // dpkg --configure -a 本身幂等安全,重试不会有副作用,只是给锁释放留出窗口。
        await new Promise((resolve) => setTimeout(resolve, 2000));
        fix = await runForeground("dpkg --configure -a", (ctx.cwd ?? ctx.workspaceRoot));
      }
      parts.push(
        fix.code === 0
          ? "[自动恢复] 检测到包管理器命令被中断打断,已跑 `dpkg --configure -a` 修复 dpkg 状态,可以重试。"
          : `[自动恢复失败] 检测到包管理器命令被中断打断,尝试 \`dpkg --configure -a\` 修复但仍失败(已重试1次)——继续前建议手动确认 dpkg 状态。${fix.stderr.trim() ? `\n[恢复命令输出]\n${fix.stderr.trim()}` : ""}`,
      );
    }
    return spillOutput(parts.join("\n"), (ctx.cwd ?? ctx.workspaceRoot));
  },
});
