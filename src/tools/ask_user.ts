import { z } from "zod";
import { defineTool } from "./types.js";

export const askUserTool = defineTool({
  name: "ask_user",
  description:
    "向用户提出一个澄清问题并等待回答。仅在缺少关键信息、且无法用其它工具获取时用;一次只问一个。可给 options 做结构化选择题——用户回序号即可(也可自由作答)。",
  capability: "read",
  approval: "auto",
  schema: z.object({
    question: z.string().describe("要问用户的问题"),
    options: z.array(z.string()).min(2).optional().describe("可选项(结构化选择);用户回序号即选中对应项"),
  }),
  handler: async (args, ctx) => {
    if (!ctx.ask) throw new Error("当前环境不支持向用户提问(ask 未配置)");
    const opts = args.options ?? [];
    // 有选项:把选项编号附在问题里,用户回序号则映射回该项,否则按自由文本。
    const prompt = opts.length
      ? `${args.question}\n${opts.map((o, i) => `  ${i + 1}. ${o}`).join("\n")}\n(回序号选择,或直接作答)`
      : args.question;
    const raw = (await ctx.ask(prompt)).trim();
    if (!raw) return "(用户未回答)";
    if (opts.length) {
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 1 && n <= opts.length) return opts[n - 1]!;
    }
    return raw;
  },
});
