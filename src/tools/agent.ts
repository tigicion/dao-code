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
    background: z
      .boolean()
      .optional()
      .describe("后台运行:立即返回任务 id 不阻塞,完成后结果会自动通知你。适合耗时长、你可同时做别的事的任务。"),
    agent_type: z
      .string()
      .optional()
      .describe("指定自定义子代理类型(见系统 prompt 的'可用子代理类型');省略则用通用子代理。"),
  }),
  handler: async (args, ctx) => {
    if ((ctx.subagentDepth ?? 0) >= 1) {
      return "子代理内不能再派发子代理(防止递归)。请自己完成或拆小任务。";
    }
    if (!ctx.runSubagent) {
      return "当前环境不支持子代理。";
    }
    const type = args.agent_type;
    if (type && ctx.agentTypes && !ctx.agentTypes.some((a) => a.name === type)) {
      const avail = ctx.agentTypes.map((a) => a.name).join(", ") || "(无)";
      return `未知子代理类型「${type}」。可用:${avail}。`;
    }
    // 后台模式:每个任务后台启动,立即返回 id;完成后经通知队列回灌(主循环不阻塞)。
    if (args.background && ctx.runBackgroundAgent) {
      const list = args.tasks?.length ? args.tasks : args.task ? [args.task] : [];
      if (list.length === 0) return "请提供 task 或 tasks。";
      const ids = list.map((t) => ctx.runBackgroundAgent!(t, type));
      return `已后台启动 ${ids.length} 个子代理${type ? `(类型 ${type})` : ""}(${ids.join(", ")});完成后会自动通知你结果。你可以先继续别的事或结束本轮。`;
    }
    const run = ctx.runSubagent;
    const tasks = args.tasks?.length ? args.tasks : args.task ? [args.task] : [];
    if (tasks.length === 0) return "请提供 task 或 tasks。";
    if (tasks.length === 1) return run(tasks[0]!, ctx.signal, type);

    // 并行 scatter-gather:各子代理独立会话并发跑,单个失败不影响其余,最后汇总。
    const results = await Promise.all(
      tasks.map(async (t, i) => {
        try {
          return `### 子代理 ${i + 1}/${tasks.length}\n任务:${t}\n\n${await run(t, ctx.signal, type)}`;
        } catch (e) {
          return `### 子代理 ${i + 1}/${tasks.length}\n任务:${t}\n\n[失败] ${e instanceof Error ? e.message : String(e)}`;
        }
      }),
    );
    return results.join("\n\n---\n\n");
  },
});
