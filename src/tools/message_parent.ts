import { z } from "zod";
import { defineTool } from "./types.js";
import { msg } from "./lang.js";

// 后台子代理给派发它的父代理发一条 mid-run 消息(进度/中间发现/澄清问题)。
// 父代理空闲时经通知队列自动收到。仅后台子代理可用(前台子代理结论在完成时直接返回)。
export const messageParentTool = defineTool({
  name: "message_parent",
  description:
    "(后台子代理用)给派发你的父代理发一条中途消息——进度、中间发现、或需要澄清的问题,不用等跑完才汇报。" +
    "父代理空闲时(下个工具回合边界)会收到,不是立刻打断它。仅当你是后台子代理时有效;前台子代理调了也没用" +
    "(结论会在完成时直接返回父代理,不需要这个中途通道)。这是子代理→父代理这个方向;反方向(父代理中途给你" +
    "追加指令)对应的是 task_send,不是这个。举例:被派去调查一个大仓库为什么构建变慢,查了一半发现是某个" +
    "依赖版本明显有问题,不确定要不要顺手升级它——这时候用它先汇报这个中间发现,而不是憋到最终结论里才提," +
    "让父代理能更早决定要不要插手。多条消息按发送顺序排队,父代理按顺序看到,不会乱序也不会覆盖前一条。" +
    "只是单向汇报,不会等父代理回应——需要它明确回话再决定下一步的话,就在消息里问清楚,然后继续做当下能做的部分,而不是原地卡住等答复。",
  descriptionEn:
    "(For background subagents) Sends a mid-run message to the parent agent that dispatched you — progress, intermediate findings, or clarifying questions — without " +
    "waiting until you finish to report. The parent receives it when idle (at its next tool turn boundary), not as an immediate interrupt. Only effective when you " +
    "are a background subagent; calling it as a foreground subagent has no effect (your conclusion is returned directly upon completion, no need for this mid-run channel). " +
    "This is the subagent→parent direction; the reverse (parent sending you an instruction mid-run) is task_send, not this. Example: dispatched to investigate why a " +
    "large repo's build got slow, midway you find a dependency version is clearly wrong but aren't sure whether to go ahead and upgrade it — use this to report that " +
    "intermediate finding now rather than saving it for the final conclusion, so the parent can decide sooner whether to step in. Multiple messages queue in send order — " +
    "the parent sees them in order, never reordered or overwritten by an earlier one.",
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
