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
    "列出任务(agent 后台派发的子代理 + task_create 手动建的,同一套系统)。默认只列运行中的——这是你确认" +
    "'我之前起的那几个后台任务还在跑吗'的方式,别自己瞎猜或者干等通知;include_finished=true 连已完成/失败/取消的也列出," +
    "能看到完整历史。这里只给每条一行摘要(状态图标+id+描述);想看某个任务的完整结果/报错/起止时间,拿到 id 后再用" +
    "task_get 精确查。图标含义:▶ running / ☑ completed / ✗ failed / ☐ canceled,扫一眼就知道整体情况,不用逐条读。" +
    "举例:之前派了三个后台子代理、记不清进度了,先无参数调一次这个,别凭印象假设它们都还在跑或都跑完了。" +
    "task_create 手动建的任务和 agent(background:true)真派发的子代理在这里没有视觉区分,想知道某条具体是哪种," +
    "还是得靠描述内容自己判断或者用 task_get 看细节。",
  descriptionEn:
    "Lists tasks (subagents dispatched in the background via agent + ones manually created via task_create — the same underlying system). By default only " +
    "running ones — this is how you check 'are the background tasks I started earlier still running', rather than guessing or just waiting for a notification; " +
    "include_finished=true also lists completed/failed/canceled for full history. Each line here is just a one-line summary (status icon + id + description); " +
    "once you have the id, use task_get for the full result/error/timestamps of a specific one. Icons: ▶ running / ☑ completed / ✗ failed / ☐ canceled — " +
    "readable at a glance without reading each line. Example: if you dispatched three background subagents earlier and lost track, call this with no arguments first — " +
    "don't assume they're all still running or all done. Manually created (task_create) tasks and genuinely dispatched (agent background:true) subagents aren't " +
    "visually distinguished here — to tell which is which, judge from the description text or check details via task_get.",
  capability: "read",
  approval: "auto",
  shouldDefer: true,
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
