import { z } from "zod";
import { defineTool } from "./types.js";
import type { ChatMessage } from "../client/types.js";

function trunc(s: string, n = 500): string {
  return s.length > n ? `${s.slice(0, n)}…(截断)` : s;
}

function textOf(content: string | { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join(" ");
}

// 把一条消息渲染成一行摘要;不值得展示的(空 content 的 system/user 等)返回 null。
function renderMessage(m: ChatMessage): string | null {
  if (m.role === "assistant") {
    const parts: string[] = [];
    if (m.content) parts.push(trunc(m.content));
    for (const tc of m.tool_calls ?? []) parts.push(`[调用 ${tc.function.name}] ${trunc(tc.function.arguments)}`);
    return parts.length ? parts.join("\n") : null;
  }
  if (m.role === "tool") {
    const text = textOf(m.content).trim();
    return text ? `[结果] ${trunc(text)}` : null;
  }
  if (m.role === "user") {
    const text = textOf(m.content).trim();
    return text ? `[追加消息] ${trunc(text)}` : null;
  }
  return null;
}

// id -> 已读到的消息条数(下次调用只返回这之后新增的)。同一个任务多次轮询会推进游标,
// 不会重复展示;游标只在进程内存活,不需要持久化(任务本身也是内存态的)。
const cursors = new Map<string, number>();

export const taskOutputTool = defineTool({
  name: "task_output",
  description: "增量读取某个【后台子代理】任务自上次调用以来新产生的中间消息(思考/工具调用/工具结果),让你在任务还在跑" +
    "的时候看到进度,不用干等 task_get 给最终结果。每次调用都会清空已读部分——不会重复看到同一条消息,漏轮询的那段" +
    "拿不回来(但 task_get 随时能查最终结果/报错,不受影响)。仅对 agent(background:true) 真正派发的子代理任务有效——" +
    "这类任务从子代理产生每条消息起就实时记录;task_create 手动建的任务没有中间消息可看,调用会提示改用 task_get。" +
    "典型场景:派了个跑很久的子代理去调研/改代码,过一会儿想知道'它现在做到哪一步了',用这个看最近几步在干什么," +
    "而不是盯着 task_list 的 running 状态干等。",
  descriptionEn: "Incrementally reads new intermediate messages (reasoning/tool calls/tool results) a background subagent task has produced since " +
    "the last call — lets you see progress while it's still running, instead of waiting for task_get's final result. Each call clears what's been " +
    "read, so you won't see the same message twice (a gap you didn't poll during is gone for good — but task_get's final result/error is unaffected). " +
    "Only works for tasks genuinely dispatched via agent(background:true) — those record every message in real time as the subagent produces it. " +
    "Tasks manually created via task_create have no intermediate messages; calling this on one tells you to use task_get instead. Typical use: you " +
    "dispatched a long-running research/coding subagent and want to know 'where is it right now' — use this to see its recent steps, rather than " +
    "staring at task_list's running status waiting.",
  capability: "read",
  approval: "auto",
  shouldDefer: true,
  schema: z.object({
    id: z.string().min(1).describe("任务 id(来自 task_list/agent(background:true) 的返回)"),
  }),
  handler: async (args, ctx) => {
    if (!ctx.taskManager) return "当前环境不支持任务追踪。";
    const t = ctx.taskManager.get(args.id);
    if (!t) return `未找到任务 ${args.id}。`;
    if (!t.messages || t.messages.length === 0) {
      return t.status === "running"
        ? "该任务暂无中间消息(可能是刚启动的子代理,还没产生第一条消息;也可能是 task_create 手动建的任务,本来就没有中间输出)。稍后再查,或用 task_get 看是否已有结果。"
        : `该任务没有记录中间消息(通常是 task_create 手动建的任务)。用 task_get 查看最终结果。`;
    }
    const from = cursors.get(args.id) ?? 0;
    const fresh = t.messages.slice(from);
    cursors.set(args.id, t.messages.length);
    const lines = fresh.map(renderMessage).filter((l): l is string => l !== null);
    if (lines.length === 0) {
      return `状态: ${t.status}(自上次查询以来没有新消息)`;
    }
    return [`状态: ${t.status}`, ...lines].join("\n");
  },
});
