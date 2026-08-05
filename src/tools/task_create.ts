import { z } from "zod";
import { defineTool } from "./types.js";

// 手动建一个任务(不背靠任何进程/promise),纯状态追踪;配合 TaskUpdate 手动推进/结束。
// 和 agent(background:true)的区别:那个是"派发并跑一个子代理";这个是"我自己记一件正在办的事"。
export const taskCreateTool = defineTool({
  name: "TaskCreate",
  description:
    "手动创建一个任务用于追踪(不启动任何进程,纯记录),返回任务 id。用于没有对应后台进程/子代理、" +
    "但想让用户和你自己能按 id 单独查询进度的多步工作(比如一件横跨好几轮对话、断断续续在推进的事)。" +
    "之后用 TaskUpdate 更新描述或标记完成/失败/取消,用 TaskGet 按 id 查详情、TaskList 看全部。" +
    "有实际子代理要跑,用 agent(background:true)而不是这个——那个真的会派发并运行,这个只是你自己记个账。" +
    "和 TodoWrite 的区别:TodoWrite 是本轮对话里可见的扁平清单,整表替换、无独立 id;这个是可以单独按 id 查询/引用的任务," +
    "适合工作分散在多轮里、或想让用户之后专门问'那个 xxx 任务现在到哪了'的场景。创建后状态默认是 running," +
    "但没有任何真实进程会让它自动结束——记得推进到位后主动用 TaskUpdate 收尾,否则它会一直挂着显示 running。",
  descriptionEn:
    "Manually creates a task for tracking (no process started, pure bookkeeping), returns a task id. Use for multi-step work with no backing process/subagent " +
    "that you and the user want to query individually by id (e.g. something spanning several turns, progressing intermittently). " +
    "Update via TaskUpdate, inspect a specific one via TaskGet, or list all via TaskList. " +
    "If there's an actual subagent to run, use agent(background:true) instead — that genuinely dispatches and runs; this just keeps your own bookkeeping. " +
    "Difference from TodoWrite: TodoWrite is a flat checklist visible within this conversation, fully replaced each call, no individual ids; this is a task " +
    "queryable/referenceable by its own id — better when work spans multiple turns or the user might later ask specifically 'where's that xxx task at'. " +
    "It starts as running by default, but no real process will ever end it automatically — remember to call TaskUpdate once the work is actually done, " +
    "or it'll hang showing running forever.",
  capability: "plan",
  approval: "auto",
  // 曾是 shouldDefer(需 ToolSearch 激活),2026-07-28 撤销:task_* 全家跟 agent(background:true)
  // 是同一套背景任务系统的两端,而管理"另一种后台机制"(exec_shell 的 background:true)的
  // BashOutput/KillShell 从未被 defer 过——同一角色的工具一半常驻一半要现查,不一致;更关键的是
  // ToolSearch 此前在 --eval/--no-mcp 场景下不注册(见 index.ts),导致这整个家族在评测环境里
  // 永久不可达,而 Agent 工具自己的说明文字明确指导"用 TaskOutput 做 checkpoint 式进度检查"——
  // 真实撞见过(torch-pipeline-parallelism 复测)模型派完后台 verify 子代理后想查进度,发现工具
  // 不可见、以为没有 ToolSearch,直接放弃等待提前收尾,子代理结果永久丢失。
  schema: z.object({
    description: z.string().min(1).describe("任务描述(简明扼要,会展示给用户)"),
  }),
  handler: async (args, ctx) => {
    if (!ctx.taskManager) return "当前环境不支持任务追踪。";
    const id = ctx.taskManager.create(args.description);
    return `已创建任务 ${id}:${args.description}`;
  },
});
