// src/agent/agent_summary.ts
import type { ChatMessage } from "../client/types.js";

export interface CacheSafeParams {
  systemPrompt: string;
  messages: ChatMessage[];
  model: string;
}

type SetAppState = (fn: (prev: Record<string, unknown>) => Record<string, unknown>) => void;

/**
 * 后台 agent 每 30s 用 flash 模型做摘要,更新任务 summary 字段。
 * 对标 CC startAgentSummarization。
 */
export function startAgentSummarization(
  taskId: string,
  _agentId: string,
  params: CacheSafeParams,
  setAppState: SetAppState,
  opts?: { intervalMs?: number },
): { stop: () => void } {
  const interval = opts?.intervalMs ?? 30_000;
  let stopped = false;

  const timer = setInterval(async () => {
    if (stopped || params.messages.length === 0) return;
    const summary = extractSimpleSummary(params.messages.slice(-20));
    setAppState((prev) => {
      const tasks = (prev as { tasks?: Record<string, unknown> }).tasks ?? {};
      const task = tasks[taskId] as Record<string, unknown> | undefined;
      if (!task || task.status !== "running") return prev;
      return { ...prev, tasks: { ...tasks, [taskId]: { ...task, summary } } };
    });
  }, interval);

  return { stop: () => { stopped = true; clearInterval(timer); } };
}

// 从消息列表提取简短活动摘要(不调 API 的降级方案)
function extractSimpleSummary(messages: ChatMessage[]): string {
  let toolCount = 0;
  let lastTool = "";
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      toolCount += m.tool_calls.length;
      lastTool = m.tool_calls[m.tool_calls.length - 1]?.function.name ?? lastTool;
    }
  }
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const lastText = lastAssistant && typeof lastAssistant.content === "string" ? lastAssistant.content.slice(0, 80) : "";
  return `工具调用: ${toolCount} | 最近: ${lastTool}${lastText ? ` | ${lastText}` : ""}`;
}
