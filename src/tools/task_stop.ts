import { z } from "zod";
import { defineTool } from "./types.js";

// capability=exec(能真正中止一个在跑的进程/子代理),approval=auto——语义是"清理已批准的后台工作",
// 同 KillShell 的定级(工作本身已经过批准,提前结束它不需要再问一遍)。
export const taskStopTool = defineTool({
  name: "TaskStop",
  description:
    "停止一个任务:如果是后台子代理会被真正中止(发 abort 信号,不再消耗 token/时间);如果是 TaskCreate 建的" +
    "手动任务,没有真实进程可中止,只是把状态标记为 canceled。已结束的任务(不管是自然完成/失败/已经 canceled 过)" +
    "调用无效,返回未生效,不会报错崩溃。用户明确说'不用跑了/算了/停掉那个任务'时用这个,别放着让它白跑浪费时间和 token。" +
    "只停止它继续跑,不会撤销它已经做过的文件改动——想撤销改动是另一回事(看 git 状态、手动 revert),别以为停了任务" +
    "就等于恢复原状了。停之前如果还有没读的中途输出,先用 TaskGet 看一眼再停,免得白白丢掉有价值的中间信息。" +
    "停止是终态,不能再重新启动同一个 id,要重跑只能重新调用 agent/TaskCreate 建一个新任务。",
  descriptionEn:
    "Stops a task: if it's a background subagent, it's genuinely aborted (sends an abort signal, no more token/time spent); if it's a manually created " +
    "(TaskCreate) task, there's no real process to abort — it's just marked canceled. A no-op on already-ended tasks (naturally completed/failed/already " +
    "canceled) — returns not-applied rather than erroring. Use this when the user explicitly says 'never mind, stop that task' — don't let it keep running " +
    "and burning time/tokens for nothing. This only stops it from continuing; it does NOT undo file changes it already made — undoing changes is a separate " +
    "matter (check git status, revert manually) — don't assume stopping the task restores the original state. If there's unread mid-run output, check it via " +
    "TaskGet before stopping so you don't lose valuable intermediate information for nothing. Stopping is terminal — you cannot restart the same id; to redo the " +
    "work, dispatch a fresh one via agent/TaskCreate.",
  capability: "exec",
  approval: "auto",
  shouldDefer: true,
  schema: z.object({
    id: z.string().min(1).describe("任务 id"),
  }),
  handler: async (args, ctx) => {
    if (!ctx.taskManager) return "当前环境不支持任务追踪。";
    const ok = ctx.taskManager.cancel(args.id);
    return ok ? `已停止任务 ${args.id}。` : `任务 ${args.id} 不存在或已结束,未生效。`;
  },
});
