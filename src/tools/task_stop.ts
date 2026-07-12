import { z } from "zod";
import { defineTool } from "./types.js";

// capability=exec(能真正中止一个在跑的进程/子代理),approval=auto——语义是"清理已批准的后台工作",
// 同 exec_shell_kill 的定级(工作本身已经过批准,提前结束它不需要再问一遍)。
export const taskStopTool = defineTool({
  name: "task_stop",
  description:
    "停止一个任务:后台子代理会被真正中止(不再消耗 token/时间);task_create 建的手动任务会被标记为 canceled。" +
    "已结束的任务调用无效(返回未生效)。",
  descriptionEn:
    "Stops a task: a background subagent is genuinely aborted (no more token/time spent); a manually created (task_create) task is marked canceled. " +
    "No-op on already-ended tasks (returns not-applied).",
  capability: "exec",
  approval: "auto",
  schema: z.object({
    id: z.string().min(1).describe("任务 id"),
  }),
  handler: async (args, ctx) => {
    if (!ctx.taskManager) return "当前环境不支持任务追踪。";
    const ok = ctx.taskManager.cancel(args.id);
    return ok ? `已停止任务 ${args.id}。` : `任务 ${args.id} 不存在或已结束,未生效。`;
  },
});
