import { z } from "zod";
import { defineTool } from "./types.js";
import { processManager } from "./process_manager.js";
import { isDangerousCommand } from "../permissions/bash_safety.js";
import { hasSuspiciousUnicode } from "../permissions/sanitize.js";

const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 3600000;
const DEFAULT_TIMEOUT_MS = 300000;
const POLL_INTERVAL_MS = 100;
const BATCH_WINDOW_MS = 200;

export const monitorTool = defineTool({
  name: "monitor",
  description: "起一个后台监控:跑一段脚本/命令,把它的 stdout 按行实时推送成通知(200ms 内的多行会合并成一条,避免刷屏)," +
    "不用你反复调用什么工具去看它输出了没有——新内容自己会出现在对话里。适合'某条日志出现 ERROR 就告诉我'" +
    "'构建每完成一步就汇报'这类持续关注的场景;和 exec_shell 的 background 不一样——exec_shell 要你自己用 " +
    "exec_shell_poll 主动去查,monitor 是它主动推给你。命令必须能自己退出(或用 persistent:true 让它跑满整个" +
    "会话,靠 task_stop 手动结束)——写 tail -f/while true 这类不会自己退出的命令时,搭配 persistent:true;" +
    "只想要'某个条件满足时通知我一次'这种场景,让命令在条件满足后自己 exit,别用不会退出的命令加超时硬等。" +
    "默认 5 分钟超时(未设 persistent 时),到点自动终止并结算;persistent:true 时不设超时,靠 task_stop 主动停。" +
    "危险命令(rm -rf、curl|sh 等)仍会被拦截强制确认,和 exec_shell 同一套规则。",
  descriptionEn: "Starts a background monitor: runs a script/command and pushes its stdout as real-time notifications, one line per event (lines " +
    "within 200ms are batched into one to avoid flooding). No need to keep calling something to check for output — new content just shows up. Good " +
    "for 'tell me when an ERROR line appears' or 'report each build step' — unlike exec_shell's background mode where you have to actively poll via " +
    "exec_shell_poll, monitor pushes to you instead. The command must exit on its own (or pass persistent:true to keep it running for the whole " +
    "session, stopped manually via task_stop) — for commands that never exit on their own (tail -f, while true), pair them with persistent:true; " +
    "for 'notify me once when condition X is met', make the command exit once the condition is met rather than using a non-exiting command plus a " +
    "hard timeout. Defaults to a 5-minute timeout when not persistent, auto-terminating and settling at that point; persistent:true means no " +
    "timeout, stop manually via task_stop. Dangerous commands (rm -rf, curl|sh, etc.) are still forced to confirmation, same rules as exec_shell.",
  capability: "exec",
  approval: "required",
  shouldDefer: true,
  checkPermissions: (argsJson) => {
    try {
      const parsed = JSON.parse(argsJson) as { command?: string };
      if (typeof parsed.command === "string" && (isDangerousCommand(parsed.command) || hasSuspiciousUnicode(parsed.command))) return "ask";
    } catch { /* 参数未成形 */ }
    return null;
  },
  schema: z.object({
    command: z.string().min(1).describe("shell 命令/脚本;stdout 的每一行都是一个事件"),
    description: z.string().min(1).describe("监控内容的简短描述(出现在每条通知里)"),
    persistent: z.boolean().optional().describe("true=跑满整个会话不设超时,靠 task_stop 结束;默认 false"),
    timeout_ms: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional()
      .describe(`超时后自动终止(毫秒),默认 ${DEFAULT_TIMEOUT_MS};persistent:true 时忽略`),
  }),
  handler: async (args, ctx) => {
    if (!ctx.taskManager) return "当前环境不支持任务追踪,monitor 需要它才能推送通知。";
    const cwd = ctx.cwd ?? ctx.workspaceRoot;
    const procId = processManager.start(args.command, cwd);
    const timeoutMs = args.persistent ? undefined : (args.timeout_ms ?? DEFAULT_TIMEOUT_MS);

    const taskId = ctx.taskManager.launch(args.description, (signal, id) =>
      new Promise<string>((resolve) => {
        let finished = false;
        let lineBuffer = "";
        let pendingLines: string[] = [];
        let flushTimer: ReturnType<typeof setTimeout> | undefined;

        const flush = () => {
          if (pendingLines.length === 0) return;
          const batch = pendingLines.join("\n");
          pendingLines = [];
          ctx.taskManager!.emitFromTask(id, batch);
        };

        const finish = (summary: string) => {
          if (finished) return;
          finished = true;
          clearInterval(poller);
          if (flushTimer) clearTimeout(flushTimer);
          if (timeoutTimer) clearTimeout(timeoutTimer);
          signal.removeEventListener("abort", onAbort);
          flush();
          resolve(summary);
        };

        const onAbort = () => {
          try { processManager.kill(procId); } catch { /* 进程可能已经退出 */ }
          finish(`监控已被取消:${args.description}`);
        };
        signal.addEventListener("abort", onAbort, { once: true });

        const timeoutTimer = timeoutMs !== undefined
          ? setTimeout(() => {
            try { processManager.kill(procId); } catch { /* 进程可能已经退出 */ }
            finish(`监控超时(${timeoutMs}ms)已自动终止:${args.description}`);
          }, timeoutMs)
          : undefined;

        const poller = setInterval(() => {
          const r = processManager.poll(procId);
          if (r.stdout) {
            const parts = (lineBuffer + r.stdout).split("\n");
            lineBuffer = parts.pop() ?? ""; // 末尾不完整的一行留到下次拼接
            for (const line of parts) if (line.length > 0) pendingLines.push(line);
            if (pendingLines.length > 0) {
              if (flushTimer) clearTimeout(flushTimer);
              flushTimer = setTimeout(flush, BATCH_WINDOW_MS);
            }
          }
          if (r.status === "exited") {
            if (lineBuffer.trim()) { pendingLines.push(lineBuffer); lineBuffer = ""; }
            finish(`监控结束(命令已退出,exit ${r.exitCode ?? ""}${r.signal ? ` signal ${r.signal}` : ""}):${args.description}`);
          }
        }, POLL_INTERVAL_MS);
      }),
    );

    return `已在后台启动监控(task id=${taskId}):${args.description}。命令输出会按行批量作为通知推送给你,不用轮询;` +
      `想提前结束用 task_stop。`;
  },
});
