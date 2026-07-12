import { z } from "zod";
import { defineTool } from "./types.js";

export const taskGetTool = defineTool({
  name: "task_get",
  description: "查询某个任务的完整详情(状态、结果或报错、起止时间)。id 来自 task_list/task_create/agent(background:true) 的返回。",
  descriptionEn: "Gets full detail of a task (status, result or error, start/end time). id comes from task_list/task_create/agent(background:true)'s return value.",
  capability: "read",
  approval: "auto",
  schema: z.object({
    id: z.string().min(1).describe("任务 id"),
  }),
  handler: async (args, ctx) => {
    if (!ctx.taskManager) return "当前环境不支持任务追踪。";
    const t = ctx.taskManager.get(args.id);
    if (!t) return `未找到任务 ${args.id}。`;
    const lines = [
      `id: ${t.id}`,
      `描述: ${t.description}`,
      `状态: ${t.status}`,
      `开始: ${new Date(t.startedAt).toISOString()}`,
    ];
    if (t.endedAt) lines.push(`结束: ${new Date(t.endedAt).toISOString()}`);
    if (t.result) lines.push(`结果:\n${t.result}`);
    if (t.error) lines.push(`报错:\n${t.error}`);
    return lines.join("\n");
  },
});
