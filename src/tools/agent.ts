import { z } from "zod";
import { defineTool } from "./types.js";

export const agentTool = defineTool({
  name: "agent",
  description:
    "把独立子任务派发给子代理:它用同样的工具自主跑完、只返回最终结果(你看不到中间过程)。" +
    "任务描述要自包含——子代理没有当前对话上下文。" +
    "传 task 派单个;传 tasks 数组则并行派发多个并汇总(适合可并行的独立调查/分析)。" +
    "并行任务务必彼此独立、互不依赖;需要同时改文件的任务不要并行,以免互相冲突。",
  capability: "plan",
  approval: "auto",
  schema: z.object({
    task: z.string().min(1).optional().describe("单个子任务(与 tasks 二选一)"),
    tasks: z
      .array(z.string().min(1))
      .min(1)
      .max(6)
      .optional()
      .describe("多个相互独立的子任务,将并行派发并汇总(最多 6 个)"),
  }),
  handler: async (args, ctx) => {
    if ((ctx.subagentDepth ?? 0) >= 1) {
      return "子代理内不能再派发子代理(防止递归)。请自己完成或拆小任务。";
    }
    if (!ctx.runSubagent) {
      return "当前环境不支持子代理。";
    }
    const run = ctx.runSubagent;
    const tasks = args.tasks?.length ? args.tasks : args.task ? [args.task] : [];
    if (tasks.length === 0) return "请提供 task 或 tasks。";
    if (tasks.length === 1) return run(tasks[0]!);

    // 并行 scatter-gather:各子代理独立会话并发跑,单个失败不影响其余,最后汇总。
    const results = await Promise.all(
      tasks.map(async (t, i) => {
        try {
          return `### 子代理 ${i + 1}/${tasks.length}\n任务:${t}\n\n${await run(t)}`;
        } catch (e) {
          return `### 子代理 ${i + 1}/${tasks.length}\n任务:${t}\n\n[失败] ${e instanceof Error ? e.message : String(e)}`;
        }
      }),
    );
    return results.join("\n\n---\n\n");
  },
});
