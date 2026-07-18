import { z } from "zod";
import { defineTool } from "./types.js";
import { scheduleAdd, scheduleList, scheduleRemove } from "../schedule.js";

// 让"每天/每隔…自动跑/提醒…"这类自然语言能路由到本地定时(OS crontab + headless dao)。
// 与操作员命令 `dao schedule` 共用 schedule.ts;写 crontab 有副作用,故 exec + 需审批。
export const scheduleTool = defineTool({
  name: "Schedule",
  description:
    "管理本地定时任务(OS crontab,到点 cd 到当前工作区、headless 跑一次 dao 带这个 prompt,输出落" +
    "~/.dao/schedule.log)。用户表达'每天/每周/每隔…自动跑/提醒/检查…'这类定时需求时用。" +
    "action=add 需 cron(5 字段如 '0 9 * * *')+ prompt;list 列出现有的;remove 需 index(先 list 看序号)。" +
    "机器需要开机且没休眠才会触发,不是保证一定按时跑。到点跑起来的是 headless 一次性调用,没有终端可以回答审批弹窗——" +
    "写这个定时 prompt 时要么让它只做只读/auto 级别的事,要么提前跟用户确认好这台机器的审批策略允许免确认执行," +
    "否则任务到点很可能卡住或什么都没做成。",
  descriptionEn:
    "Manages local scheduled tasks (OS crontab; at the scheduled time, cd's into the current workspace and runs dao headlessly with this prompt once, output " +
    "goes to ~/.dao/schedule.log). Use when the user expresses recurring needs like 'every day / every week / every X hours, automatically run / remind / check...'. " +
    "action=add requires cron (5 fields, e.g. '0 9 * * *') + prompt; list shows existing entries; remove requires index (list first to see the numbers). " +
    "The machine must be powered on and awake to trigger — not a guarantee it fires exactly on time. The triggered run is a one-shot headless invocation with no " +
    "terminal to answer approval prompts — write the scheduled prompt to only do read-only/auto-approved things, or confirm with the user beforehand that this " +
    "machine's approval policy allows unattended execution, otherwise the task will likely hang or accomplish nothing when it fires.",
  capability: "exec",
  approval: "required",
  shouldDefer: true,
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
