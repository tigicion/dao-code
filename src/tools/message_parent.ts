import { z } from "zod";
import { defineTool } from "./types.js";
import { msg } from "./lang.js";

// 后台子代理给派发它的父代理发一条 mid-run 消息(进度/中间发现/澄清问题)。
// 父代理空闲时经通知队列自动收到。仅后台子代理可用(前台子代理结论在完成时直接返回)。
export const messageParentTool = defineTool({
  name: "message_parent",
  description:
    "(后台子代理用)给派发你的父代理发一条中途消息——进度、中间发现、或需要澄清的问题。父代理空闲时会收到。" +
    "仅当你是后台子代理时有效;前台子代理无需用它(结论会在完成时直接返回父代理)。",
  descriptionEn:
    "(For background subagents) Sends a mid-run message to the parent agent that dispatched you — progress, intermediate findings, or clarifying questions. The parent receives it when idle. " +
    "Only effective when you are a background subagent; foreground subagents don't need this (their conclusion is returned directly upon completion).",
  capability: "plan",
  approval: "auto",
  schema: z.object({
    message: z.string().min(1).describe("发给父代理的中途消息(进度/发现/问题)"),
  }),
  handler: async (args, ctx) => {
    if (!ctx.messageParent) {
      return "你不是后台子代理(无父任务通道):你的结论会在完成时直接返回父代理,无需中途发送。";
    }
    ctx.messageParent(args.message);
    return msg("已发送给父代理(它空闲时会看到)。", "Sent to parent agent (it will see this when idle).");
  },
});
