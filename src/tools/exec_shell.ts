import { spawn } from "node:child_process";
import { z } from "zod";
import { defineTool } from "./types.js";
import { processManager } from "./process_manager.js";
import { spillOutput } from "./spill.js";

interface ForegroundResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
  aborted: boolean;
}

const OUT_CAP = 10 * 1024 * 1024; // 内存中累积输出上限,超出截断(防 OOM)

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
    const child = spawn(command, { cwd, shell: true, detached: true });
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
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (capped) stderr += "\n[输出超过 10MB 上限被截断,请用更精确的命令或重定向到文件后再 grep/read_file]";
      resolve({ stdout, stderr, code, timedOut, aborted });
    };
    child.on("error", (e) => { stderr += String((e as Error).message ?? e); finish(1); });
    child.on("close", (code) => finish(typeof code === "number" ? code : 1));
  });
}

export const execShellTool = defineTool({
  name: "exec_shell",
  description:
    "在工作区目录执行 shell 命令(git、测试、find 等都走它)。前台执行返回输出与退出码;background=true 则后台启动并返回进程 id(用 exec_shell_poll 读输出、exec_shell_kill 结束)。",
  capability: "exec",
  approval: "required",
  schema: z.object({
    command: z.string().describe("要执行的 shell 命令"),
    background: z.boolean().optional().describe("是否后台运行(长任务/服务)"),
    timeout: z.number().int().min(1).optional().describe("前台超时(毫秒),默认 120000"),
  }),
  // 参数级自检:管道直灌 shell / 下载即执行 / eval 等高危模式 → 强制确认(即使有放宽规则放行)。
  checkPermissions: (argsJson) => {
    try {
      const { command } = JSON.parse(argsJson) as { command?: string };
      if (typeof command === "string" && /\|\s*(sh|bash|zsh|fish)\b|\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash)\b|\beval\b|\bsudo\b/.test(command)) return "ask";
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
    return spillOutput(parts.join("\n"), ctx.workspaceRoot);
  },
});
