// src/agent/agent_tools.ts
import type { ChatMessage, AssistantMessage } from "../client/types.js";
import { ToolRegistry } from "../tools/registry.js";
import type { AgentDef } from "./agent_defs.js";
import type { Tool } from "../tools/types.js";

// ---- 工具禁用/允许清单 ----

export const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  "agent",
  "ask_user",
  "task_stop",
]);

export const CUSTOM_AGENT_DISALLOWED_TOOLS = new Set([
  ...ALL_AGENT_DISALLOWED_TOOLS,
]);

export const ASYNC_AGENT_ALLOWED_TOOLS = new Set([
  "read_file", "list_dir", "grep_files", "file_search",
  "exec_shell", "exec_shell_poll", "exec_shell_kill",
  "write_file", "edit_file", "multi_edit", "notebook_edit",
  "web_search", "fetch_url",
  "todo_write",
  "skill",
  "memory_write", "memory_read",
  "notify_user",
  "verify_done",
  "message_parent", // 后台子代理给父发 mid-run 消息的唯一出口(DAO 特有,不在 spec 原清单内)
]);

// 一次性 agent(不支持 resume)
export const ONE_SHOT_AGENT_TYPES = new Set(["explore", "plan"]);

// ---- 工具过滤 ----

export function filterToolsForAgent({
  tools,
  isBuiltIn,
  isAsync = false,
}: {
  tools: ToolRegistry;
  isBuiltIn: boolean;
  isAsync?: boolean;
}): ToolRegistry {
  const internal = tools as unknown as { tools: Map<string, Tool> };
  const filtered = new ToolRegistry();
  for (const [name, tool] of internal.tools) {
    if (ALL_AGENT_DISALLOWED_TOOLS.has(name)) continue;
    if (!isBuiltIn && CUSTOM_AGENT_DISALLOWED_TOOLS.has(name)) continue;
    if (isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(name)) continue;
    filtered.register(tool);
  }
  return filtered;
}

export function resolveAgentTools(
  agentDef: Pick<AgentDef, "tools" | "disallowedTools" | "source">,
  availableTools: ToolRegistry,
  isAsync = false,
): { resolvedTools: ToolRegistry; hasWildcard: boolean } {
  const isBuiltIn = agentDef.source === "built-in";
  const filtered = filterToolsForAgent({
    tools: availableTools,
    isBuiltIn,
    isAsync,
  });

  const disallowedSet = new Set(agentDef.disallowedTools ?? []);
  const allowedFiltered = (() => {
    const internal = filtered as unknown as { tools: Map<string, Tool> };
    const r = new ToolRegistry();
    for (const [name, tool] of internal.tools) {
      if (!disallowedSet.has(name)) r.register(tool);
    }
    return r;
  })();

  const hasWildcard = agentDef.tools === undefined || (agentDef.tools.length === 1 && agentDef.tools[0] === "*");
  if (hasWildcard) {
    return { resolvedTools: allowedFiltered, hasWildcard: true };
  }

  const toolSet = new Set(agentDef.tools ?? []);
  const internal = allowedFiltered as unknown as { tools: Map<string, Tool> };
  const r = new ToolRegistry();
  for (const [name, tool] of internal.tools) {
    if (toolSet.has(name)) r.register(tool);
  }
  return { resolvedTools: r, hasWildcard: false };
}

// ---- 进度追踪 ----

export interface AgentProgress {
  tokenCount: number;
  toolUseCount: number;
  durationMs: number;
  lastActivity?: {
    activityDescription: string;
    toolName: string;
    timestamp: number;
  };
}

export interface ProgressTracker {
  getProgress(): AgentProgress;
  updateFromMessage(msg: ChatMessage): void;
}

function resolveActivityDescription(msg: ChatMessage): string {
  if (msg.role !== "tool") return `使用 ${msg.role}`;
  const content = typeof msg.content === "string" ? msg.content : "";
  // 从 tool result 反推活动描述过于间接;用 tool_call_id 关联更准
  // 简化:返回通用描述
  return `工具返回(${content.slice(0, 40)})`;
}

export function createProgressTracker(): ProgressTracker {
  const start = Date.now();
  const tokenCount = 0; // 已知技术债:AssistantMessage 无 usage 字段,暂不能累计
  let toolUseCount = 0;
  let lastActivity: AgentProgress["lastActivity"];

  return {
    getProgress() {
      return { tokenCount, toolUseCount, durationMs: Date.now() - start, lastActivity };
    },
    updateFromMessage(msg: ChatMessage) {
      if (msg.role === "assistant") {
        const a = msg as AssistantMessage;
        if (a.tool_calls) toolUseCount += a.tool_calls.length;
      }
      if (msg.role === "tool") {
        lastActivity = {
          activityDescription: resolveActivityDescription(msg),
          toolName: "tool",
          timestamp: Date.now(),
        };
      }
    },
  };
}

// ---- 结果汇总 ----

export interface AgentToolResult {
  agentId: string;
  agentType?: string;
  content: { type: "text"; text: string }[];
  totalDurationMs: number;
  totalTokens: number;
  totalToolUseCount: number;
}

export function finalizeAgentTool(
  messages: ChatMessage[],
  agentId: string,
  metadata: {
    prompt: string;
    model: string;
    agentType: string;
    startTime: number;
    isAsync: boolean;
    isBuiltInAgent: boolean;
  },
): AgentToolResult {
  // 从后往前找最后一条有文本的 assistant
  let content: { type: "text"; text: string }[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const text = typeof m.content === "string" ? m.content : "";
    if (text) { content = [{ type: "text", text }]; break; }
  }

  let totalToolUseCount = 0;
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) totalToolUseCount += m.tool_calls.length;
  }

  return {
    agentId,
    agentType: metadata.agentType,
    content,
    totalDurationMs: Date.now() - metadata.startTime,
    totalTokens: 0, // TODO: 从最后一条 assistant 的 usage 提取
    totalToolUseCount,
  };
}
