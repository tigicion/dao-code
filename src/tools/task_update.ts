import { z } from "zod";
import { defineTool } from "./types.js";

export const taskUpdateTool = defineTool({
  name: "TaskUpdate",
  description:
    "更新一个任务:改描述,和/或把它标记为 completed/failed/canceled(带 result 说明结论或原因)。" +
    "只对 TaskCreate 手动建的任务、或想提前结束正在跑的任务有意义——真正跑完的后台子代理会自动结算,不需要手动 update," +
    "别对一个真正在跑的子代理任务手动标 completed,那样会和它自己的结算撞车。已经结束(非 running)的任务不能再改状态" +
    "(防止和已经发生过的结算重复),但描述随时能改。标成 completed/failed 会触发和真正后台任务完成一样的通知" +
    "(用户会看到'收到 N 个后台任务结果'),不是静默改个字段。举例:自己手动记的一个待办类任务做完了,想让它在" +
    "任务列表里正确显示为已完成而不是一直挂着 running,就用它标记,别只在对话里口头说'这个做完了'却不更新状态。",
  descriptionEn:
    "Updates a task: change its description, and/or mark it completed/failed/canceled (with result explaining the outcome). " +
    "Mainly useful for manually created tasks (TaskCreate), or to end a running one early — real background subagents auto-settle on their own, no manual update needed; " +
    "don't manually mark a genuinely-running subagent task completed, that would race with its own settlement. Status can't be changed once a task has ended " +
    "(non-running) — prevents duplicating a settlement that already happened — but description can be updated any time. Marking completed/failed triggers the same " +
    "notification as a real background task finishing (the user sees 'received N background task results'), not a silent field change. Example: a manually tracked " +
    "todo-style task is actually done — mark it here so TaskList correctly shows completed instead of hanging as running forever, rather than just saying " +
    "'done' in conversation without updating its status.",
  capability: "plan",
  approval: "auto",
  // 不再 defer,见 task_create.ts 顶部注释(2026-07-28)。
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
