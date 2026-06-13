import { z } from "zod";
import { defineTool } from "./types.js";

export const askUserTool = defineTool({
  name: "ask_user",
  description:
    "向用户提出一个澄清问题并等待回答。仅在缺少关键信息、且无法用其它工具获取时用;一次只问一个。" +
    "给 options 做结构化选择(单选:用户按数字或 ↑↓ 选 + Enter;multiSelect=true 时用 checkbox 多选)。" +
    "系统会自动附'其他(自己输入)'与'先讨论一下'两项,你只写正常选项。返回:选中项(多选逗号分隔)/ 用户自填内容 / 讨论意向。",
  capability: "read",
  approval: "auto",
  schema: z.object({
    question: z.string().describe("要问用户的问题"),
    options: z.array(z.string()).min(2).optional().describe("正常可选项(无需写'其他'/'先讨论',会自动加)"),
    multiSelect: z.boolean().optional().describe("是否允许多选(checkbox);默认单选"),
  }),
  handler: async (args, ctx) => {
    if (!ctx.ask) throw new Error("当前环境不支持向用户提问(ask 未配置)");
    const opts = args.options ?? [];
    if (opts.length >= 1 && ctx.askChoice) return (await ctx.askChoice(args.question, opts, args.multiSelect)).trim() || "(用户未回答)";
    const raw = (await ctx.ask(args.question)).trim();
    return raw || "(用户未回答)";
  },
});
