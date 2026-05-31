import { z } from "zod";
import { defineTool } from "./types.js";

// SendMessage:给正在后台运行的子代理任务追加指令,它在下一个工具回合边界消费。用于中途纠偏/补充信息。
export const taskSendTool = defineTool({
  name: "task_send",
  description:
    "给一个正在后台运行的子代理任务追加指令(SendMessage),它会在下一个工具回合边界收到。用于中途纠偏或补充信息。",
  capability: "plan",
  approval: "auto",
  schema: z.object({
    id: z.string().describe("后台任务 id(如 task-3)"),
    message: z.string().min(1).describe("要追加给该任务的指令"),
  }),
  handler: async (args, ctx) => {
    if (!ctx.sendToTask) return "当前环境不支持后台任务消息。";
    return ctx.sendToTask(args.id, args.message)
      ? `已发送给 ${args.id}(下一回合边界生效)。`
      : `${args.id} 不存在或已结束,无法发送。`;
  },
});
