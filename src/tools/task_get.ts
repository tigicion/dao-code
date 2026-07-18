import { z } from "zod";
import { defineTool } from "./types.js";

export const taskGetTool = defineTool({
  name: "TaskGet",
  description: "查询某个任务的完整详情:状态(running/completed/failed/canceled)、完成时给的结果或失败时的报错、起止时间。" +
    "id 来自 TaskList/TaskCreate/agent(background:true) 的返回,不是随便猜的字符串。想知道某个具体任务" +
    "'现在到哪了/最终结果是什么',用这个精确查一条;想看全部在跑/全部历史,用 TaskList。用户问'那个后台任务" +
    "怎么样了'这类话时,先用 TaskList 找到对应 id(如果记不住),再用这个拿完整详情回答,别凭印象瞎猜结果。" +
    "查一个不存在的 id 会明确告知未找到,不会返回空内容让你误以为任务还没开始。status=running 时 result/报错" +
    "字段自然是空的,别把这当成'查询失败',先看 status 字段判断,再决定是继续等还是有别的问题。",
  descriptionEn: "Gets full detail of a task: status (running/completed/failed/canceled), the result if completed or the error if failed, start/end time. " +
    "id comes from TaskList/TaskCreate/agent(background:true)'s return value, not a guessed string. Use this to check exactly where one specific task " +
    "stands or what its final result was; use TaskList to see everything running or the full history. When the user asks 'how's that background task going', " +
    "find its id via TaskList first if you don't recall it, then get the full detail here — don't guess the outcome from memory. Querying a nonexistent id " +
    "clearly reports not-found rather than returning empty content that could be mistaken for 'not started yet'. While status=running, the result/error fields are " +
    "naturally empty — don't read that as a query failure; check the status field first to decide whether to keep waiting or something else is wrong.",
  capability: "read",
  approval: "auto",
  shouldDefer: true,
  schema: z.object({
    id: z.string().min(1).describe("任务 id"),
  }),
  handler: async (args, ctx) => {
    if (!ctx.taskManager) return "当前环境不支持任务追踪。";
    const t = ctx.taskManager.get(args.id);
    if (!t) return `未找到任务 ${args.id}。`;
    const lines = [
      `id: ${t.id}`,
      `描述: ${t.description}`,
      `状态: ${t.status}`,
      `开始: ${new Date(t.startedAt).toISOString()}`,
    ];
    if (t.endedAt) lines.push(`结束: ${new Date(t.endedAt).toISOString()}`);
    if (t.result) lines.push(`结果:\n${t.result}`);
    if (t.error) lines.push(`报错:\n${t.error}`);
    return lines.join("\n");
  },
});
