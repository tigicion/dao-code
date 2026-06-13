import { z } from "zod";
import { defineTool } from "./types.js";
import { scheduleAdd, scheduleList, scheduleRemove } from "../schedule.js";

// 让"每天/每隔…自动跑/提醒…"这类自然语言能路由到本地定时(OS crontab + headless dao)。
// 与操作员命令 `dao schedule` 共用 schedule.ts;写 crontab 有副作用,故 exec + 需审批。
export const scheduleTool = defineTool({
  name: "schedule",
  description:
    "管理本地定时任务(OS crontab,到点用 headless dao 在当前工作区跑一个 prompt)。" +
    "用户表达'每天/每周/每隔…自动跑/提醒/检查…'这类定时需求时用。" +
    "action=add 需 cron(5 字段如 '0 9 * * *')+ prompt;list 列出;remove 需 index。机器需开机才会触发。",
  capability: "exec",
  approval: "required",
  schema: z.object({
    action: z.enum(["add", "list", "remove"]).describe("add 添加 / list 列出 / remove 删除"),
    cron: z.string().optional().describe("add:5 字段 cron,如 '0 9 * * *'(每天 9 点)"),
    prompt: z.string().optional().describe("add:到点要跑的 prompt"),
    index: z.number().int().min(1).optional().describe("remove:dao schedule list 里的序号"),
  }),
  handler: async (args, ctx) => {
    let out = "";
    const w = (s: string) => { out += s; };
    if (args.action === "add") {
      if (!args.cron || !args.prompt) return "add 需要 cron(5 字段)和 prompt。";
      await scheduleAdd(args.cron, args.prompt, ctx.workspaceRoot, process.execPath, w);
    } else if (args.action === "list") {
      await scheduleList(w);
    } else {
      if (args.index == null) return "remove 需要 index(先 list 看序号)。";
      await scheduleRemove(args.index, w);
    }
    return out.trim() || "(完成)";
  },
});
