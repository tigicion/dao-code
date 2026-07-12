import { z } from "zod";
import { defineTool } from "./types.js";

// 手动建一个任务(不背靠任何进程/promise),纯状态追踪;配合 task_update 手动推进/结束。
// 和 agent(background:true)的区别:那个是"派发并跑一个子代理";这个是"我自己记一件正在办的事"。
export const taskCreateTool = defineTool({
  name: "task_create",
  description:
    "手动创建一个任务用于追踪(不启动任何进程,纯记录),返回任务 id。用于没有对应后台进程/子代理、" +
    "但想让用户和你自己能查看进度的多步工作。之后用 task_update 更新描述或标记完成/失败/取消,用 task_get/task_list 查看。" +
    "有实际子代理要跑,用 agent(background:true)而不是这个。",
  descriptionEn:
    "Manually creates a task for tracking (no process started, pure bookkeeping), returns a task id. Use for multi-step work with no backing process/subagent " +
    "that you and the user want visible progress on. Update via task_update, inspect via task_get/task_list. " +
    "If there's an actual subagent to run, use agent(background:true) instead of this.",
  capability: "plan",
  approval: "auto",
  schema: z.object({
    description: z.string().min(1).describe("任务描述(简明扼要,会展示给用户)"),
  }),
  handler: async (args, ctx) => {
    if (!ctx.taskManager) return "当前环境不支持任务追踪。";
    const id = ctx.taskManager.create(args.description);
    return `已创建任务 ${id}:${args.description}`;
  },
});
