// src/agent/agent_summary.ts
import type { ChatMessage } from "../client/types.js";

export interface CacheSafeParams {
  systemPrompt: string;
  messages: ChatMessage[];
  model: string;
}

/**
 * 后台 agent 每 30s 做一次摘要,通过 updateSummary(taskId, summary) 写回任务(对应 TaskManager.updateSummary)。
 * 对标 CC startAgentSummarization,但摘要回调直接对接 DAO TaskManager,不引入 CC 的 setAppState reducer 模式。
 */
export function startAgentSummarization(
  taskId: string,
  _agentId: string,
  params: CacheSafeParams,
  updateSummary: (taskId: string, summary: string) => void,
  opts?: { intervalMs?: number },
): { stop: () => void } {
  const interval = opts?.intervalMs ?? 30_000;
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped || params.messages.length === 0) return;
    updateSummary(taskId, extractSimpleSummary(params.messages.slice(-20)));
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
