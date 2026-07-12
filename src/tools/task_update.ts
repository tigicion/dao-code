import { z } from "zod";
import { defineTool } from "./types.js";

export const taskUpdateTool = defineTool({
  name: "task_update",
  description:
    "更新一个任务:改描述,和/或把它标记为 completed/failed/canceled(带 result 说明结论或原因)。" +
    "只对 task_create 手动建的任务、或想提前结束正在跑的任务有意义——真正跑完的后台子代理会自动结算,不需要手动 update。" +
    "已经结束(非 running)的任务不能再改状态,但描述随时能改。",
  descriptionEn:
    "Updates a task: change its description, and/or mark it completed/failed/canceled (with result explaining the outcome). " +
    "Mainly useful for manually created tasks (task_create), or to end a running one early — real background subagents auto-settle on their own, no manual update needed. " +
    "Status can't be changed once a task has ended (non-running), but description can be updated any time.",
  capability: "plan",
  approval: "auto",
  schema: z.object({
    id: z.string().min(1).describe("任务 id"),
    description: z.string().optional().describe("新描述(可选)"),
    status: z.enum(["completed", "failed", "canceled"]).optional().describe("要转到的结束状态(可选;已结束的任务无法再改)"),
    result: z.string().optional().describe("结论(status=completed 时)或原因(status=failed 时)"),
  }),
  handler: async (args, ctx) => {
    if (!ctx.taskManager) return "当前环境不支持任务追踪。";
    if (!ctx.taskManager.get(args.id)) return `未找到任务 ${args.id}。`;
    const ok = ctx.taskManager.update(args.id, { status: args.status, result: args.result, description: args.description });
    if (!ok) return `任务 ${args.id} 已结束,状态不可再改(若本次同时改了 description,那部分已生效)。`;
    return `已更新任务 ${args.id}。`;
  },
});
