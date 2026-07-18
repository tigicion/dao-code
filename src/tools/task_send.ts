import { z } from "zod";
import { defineTool } from "./types.js";
import { msg } from "./lang.js";

// SendMessage:给正在后台运行的子代理任务追加指令,它在下一个工具回合边界消费。用于中途纠偏/补充信息。
export const taskSendTool = defineTool({
  name: "TaskSend",
  description:
    "给一个正在后台运行的子代理任务追加指令,它会在下一个工具回合边界收到(不是立刻打断它当前正做的事)。" +
    "用于中途纠偏(发现它跑偏了、需要调整方向)或补充信息(漏说了什么关键约束)。id 通常是仍在 running 的任务," +
    "会在下一回合边界收到;如果已经结束(非一次性 agent),会自动从磁盘转录恢复该子代理并把这条消息作为新指令注入" +
    "继续执行,不需要你先判断它是否还活着。这是父代理→子代理这个方向;反方向(子代理主动给父代理" +
    "汇报进度)对应的是 MessageParent,不是这个。举例:派了个后台子代理去重构一个模块,过程中用户又补充了" +
    "一条约束(比如'顺便把这个函数名也统一改一下'),这时候用 TaskSend 把这条追加进去,不用取消重派一次。" +
    "发送后不会立刻收到确认执行的回执,任务会在下一次它自己调用工具时才消费这条消息,期间它可能已经推进了几步。",
  descriptionEn:
    "Sends an additional instruction to a running background subagent task; it receives it at the next tool turn boundary (not an immediate interrupt of what " +
    "it's currently doing). Use for mid-course correction (it's drifting off track, needs redirecting) or supplementary info (a key constraint you forgot to mention). " +
    "id is usually a still-running task; if it has already ended (and isn't a one-shot agent), it's automatically resumed from its on-disk transcript with this " +
    "message injected as its next instruction — you don't need to check liveness first. This is the " +
    "parent→subagent direction; the reverse (subagent proactively reporting progress to the parent) is MessageParent, not this. Example: a background subagent " +
    "is refactoring a module, and mid-way the user adds a constraint (e.g. 'also rename this function while you're at it') — use TaskSend to relay it rather " +
    "than canceling and re-dispatching. There's no immediate delivery receipt — the task consumes the message the next time it makes a tool call itself, and it may " +
    "have already advanced a few steps by then.",
  capability: "plan",
  approval: "auto",
  shouldDefer: true,
  schema: z.object({
    id: z.string().describe("后台任务 id(如 task-3)"),
    message: z.string().min(1).describe("要追加给该任务的指令"),
  }),
  handler: async (args, ctx) => {
    if (!ctx.sendToTask) return "当前环境不支持后台任务消息。";
    if (ctx.sendToTask(args.id, args.message)) {
      return msg(`已发送给 ${args.id}(下一回合边界生效)。`, `Sent to ${args.id} (effective at next turn boundary).`);
    }
    // 目标任务已结束(非"不存在"):参考 SendMessageTool——运行中走 queuePendingMessage,已停止走
    // resumeAgentBackground 从磁盘转录重建后把这条消息作为新 prompt 注入,而不是直接告知发送失败。
    const task = ctx.taskManager?.get(args.id);
    if (task && task.status !== "running" && ctx.resumeAgent) {
      try {
        await ctx.resumeAgent(args.id, args.message);
        return msg(`${args.id} 已结束,已恢复并追加该消息继续执行。`, `${args.id} had ended; resumed and appended the message.`);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return msg(`${args.id} 已结束且无法恢复:${reason}`, `${args.id} has ended and could not be resumed: ${reason}`);
      }
    }
    return msg(`${args.id} 不存在或已结束,无法发送。`, `${args.id} does not exist or has ended; cannot send.`);
  },
});
