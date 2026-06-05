import { z } from "zod";
import { defineTool } from "./types.js";

export const askUserTool = defineTool({
  name: "ask_user",
  description:
    "向用户提出一个澄清问题并等待自由文本回答。仅在缺少关键信息、且无法用其它工具获取时使用;一次只问一个。",
  capability: "read",
  approval: "auto",
  schema: z.object({
    question: z.string().describe("要问用户的问题"),
  }),
  handler: async (args, ctx) => {
    if (!ctx.ask) throw new Error("当前环境不支持向用户提问(ask 未配置)");
    const answer = (await ctx.ask(args.question)).trim();
    return answer ? answer : "(用户未回答)";
  },
});
