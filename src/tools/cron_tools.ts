import { z } from "zod";
import { defineTool } from "./types.js";
import { scheduleAdd, scheduleList, scheduleRemove } from "../schedule.js";

// 对标 CC CronCreate/CronDelete/CronList:三个独立工具替代单一 schedule。
// durable=true(默认 false)写 OS crontab;durable=false 仅 session 内存(后续实现)。
// recurring=false 一次性任务(执行后自动删除);recurring=true(默认)循环执行。
export const cronCreateTool = defineTool({
  name: "cron_create",
  description:
    "创建定时任务。cron 为 5 字段表达式(分 时 日 月 周,本地时区),如 '0 9 * * *'(每天 9 点)。" +
    "recurring: true(默认)=循环执行;false=一次性(执行后自动删除)。" +
    "durable: false(默认)=仅本会话(内存);true=持久化到 OS crontab(重启后仍生效)。" +
    "到点 headless 跑一次 dao,输出落 ~/.dao/schedule.log。机器需开机才会触发。",
  descriptionEn:
    "Create a scheduled task. cron is a 5-field expression (min hour dom month dow, local TZ), e.g. '0 9 * * *' (daily 9am). " +
    "recurring: true (default)=repeating; false=one-shot (auto-deletes after firing). " +
    "durable: false (default)=session-only (memory); true=persist to OS crontab (survives restart). " +
    "Runs dao headlessly at the scheduled time, output to ~/.dao/schedule.log. Machine must be on.",
  capability: "exec",
  approval: "required",
  shouldDefer: true,
  schema: z.object({
    cron: z.string().describe("5 字段 cron,如 '0 9 * * *'(每天 9 点)"),
    prompt: z.string().describe("到点要跑的 prompt"),
    recurring: z.boolean().optional().describe("true=循环(默认);false=一次性(执行后自动删除)"),
    durable: z.boolean().optional().describe("false=仅本会话(默认);true=持久化到 OS crontab"),
  }),
  handler: async (args, ctx) => {
    if (!args.cron || !args.prompt) return "需要 cron(5 字段)和 prompt。";
    // durable=false(session-only):后续实现内存调度器,暂不支持
    if (args.durable === false) {
      return "session-only 定时任务(durable=false)暂不支持,当前只支持持久化到 OS crontab(durable=true)。";
    }
    let out = "";
    const w = (s: string) => { out += s; };
    // 一次性任务:在 prompt 前加注释标记,执行后自动删除(通过 cron 自身机制)
    // 当前 schedule.ts 的 scheduleAdd 直接写 crontab,recurring=false 时加一行自删除提示
    const fullPrompt = args.recurring === false
      ? `[一次性任务] ${args.prompt}\n(完成后请运行 dao schedule remove 删除此定时任务)`
      : args.prompt;
    await scheduleAdd(args.cron, fullPrompt, ctx.workspaceRoot, process.execPath, w);
    if (args.recurring === false) {
      w("注意:一次性任务执行后需手动删除(用 cron_delete 或 dao schedule remove)。\n");
    }
    return out.trim() || "(完成)";
  },
});

export const cronDeleteTool = defineTool({
  name: "cron_delete",
  description:
    "按序号删除定时任务。先用 cron_list 查看序号。仅删除 durable(持久化到 OS crontab)的任务。",
  descriptionEn:
    "Delete a scheduled task by index. Use cron_list first to see the numbers. Only deletes durable (OS crontab) tasks.",
  capability: "exec",
  approval: "required",
  shouldDefer: true,
  schema: z.object({
    jobId: z.number().int().min(1).describe("cron_list 里的序号"),
  }),
  handler: async (args, ctx) => {
    let out = "";
    const w = (s: string) => { out += s; };
    await scheduleRemove(args.jobId, w);
    return out.trim() || "(完成)";
  },
});

export const cronListTool = defineTool({
  name: "cron_list",
  description: "列出所有定时任务(含序号、cron 表达式、prompt 摘要)。",
  descriptionEn: "List all scheduled tasks (index, cron expression, prompt summary).",
  capability: "read",
  approval: "auto",
  shouldDefer: true,
  schema: z.object({}),
  handler: async (_args, _ctx) => {
    let out = "";
    const w = (s: string) => { out += s; };
    await scheduleList(w);
    return out.trim() || "(暂无定时任务)";
  },
});
