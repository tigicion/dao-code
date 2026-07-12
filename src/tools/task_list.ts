import { z } from "zod";
import { defineTool } from "./types.js";
import type { BgTask } from "../agent/tasks.js";

const ICON: Record<BgTask["status"], string> = {
  running: "▶",
  completed: "☑",
  failed: "✗",
  canceled: "☐",
};

function line(t: BgTask): string {
  return `${ICON[t.status]} ${t.id}  ${t.description}`;
}

export const taskListTool = defineTool({
  name: "task_list",
  description:
    "列出任务(后台子代理 + task_create 手动建的)。默认只列运行中的;include_finished=true 连已完成/失败/取消的也列出。" +
    "想看某个任务的完整结果/报错,用 task_get 传它的 id。",
  descriptionEn:
    "Lists tasks (background subagents + manually created via task_create). By default only running ones; include_finished=true also lists completed/failed/canceled. " +
    "To see a task's full result/error, use task_get with its id.",
  capability: "read",
  approval: "auto",
  schema: z.object({
    include_finished: z.boolean().optional().describe("是否连已结束(完成/失败/取消)的任务也列出,默认 false"),
  }),
  handler: async (args, ctx) => {
    if (!ctx.taskManager) return "当前环境不支持任务追踪。";
    const tasks = args.include_finished ? ctx.taskManager.all() : ctx.taskManager.running();
    if (tasks.length === 0) return args.include_finished ? "(暂无任务)" : "(暂无运行中的任务)";
    return tasks.map(line).join("\n");
  },
});
