import { exec } from "node:child_process";
import { z } from "zod";
import { defineTool } from "./types.js";
import { processManager } from "./process_manager.js";

interface ForegroundResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

function runForeground(command: string, cwd: string, timeout: number): Promise<ForegroundResult> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 }, (err: any, stdout, stderr) => {
      const timedOut = Boolean(err?.killed) && err?.signal === "SIGTERM";
      const code = typeof err?.code === "number" ? err.code : err ? 1 : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code, timedOut });
    });
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
  handler: async (args, ctx) => {
    if (args.background) {
      const id = processManager.start(args.command, ctx.workspaceRoot);
      return `已在后台启动(id=${id})。用 exec_shell_poll 读取输出,exec_shell_kill 结束。`;
    }
    const r = await runForeground(args.command, ctx.workspaceRoot, args.timeout ?? 120000);
    const parts: string[] = [];
    if (r.stdout.trim()) parts.push(r.stdout.trimEnd());
    if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
    parts.push(r.timedOut ? `[超时,已终止]` : `[exit ${r.code}]`);
    return parts.join("\n");
  },
});
