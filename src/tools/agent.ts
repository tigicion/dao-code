import { z } from "zod";
import { defineTool } from "./types.js";

export const agentTool = defineTool({
  name: "agent",
  description:
    "把一个独立的子任务一次性派发给子代理:它用同样的工具自主跑完,只返回最终结果(你看不到它的中间过程)。适合可独立完成的调查或实现。任务描述要自包含——子代理没有当前对话上下文。",
  capability: "plan",
  approval: "auto",
  schema: z.object({
    task: z.string().min(1).describe("交给子代理的完整、自包含的任务描述"),
  }),
  handler: async (args, ctx) => {
    if ((ctx.subagentDepth ?? 0) >= 1) {
      return "子代理内不能再派发子代理(防止递归)。请自己完成或拆小任务。";
    }
    if (!ctx.runSubagent) {
      return "当前环境不支持子代理。";
    }
    return ctx.runSubagent(args.task);
  },
});
