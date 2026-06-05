// ---- 对话消息 ----
export interface SystemMessage {
  role: "system";
  content: string;
}
export interface UserMessage {
  role: "user";
  content: string;
}
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}
export interface ToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}
export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

// ---- 流式增量(用于渲染)----
export type StreamDelta =
  | { kind: "reasoning"; text: string }
  | { kind: "content"; text: string }
  | { kind: "tool_call"; index: number; name: string };

// ---- 发给 API 的工具声明 ----
export interface ApiTool {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export interface StreamChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  // 工具声明(JSON schema);省略则不带 tools 字段。
  tools?: ApiTool[];
  // 是否允许并行工具调用;省略则不带该字段(交给 API 默认)。
  parallelToolCalls?: boolean;
  // 注入 fetch,便于测试;默认用全局 fetch。
  fetchImpl?: typeof fetch;
  // 透传给 API 的额外字段(如 thinking、reasoning_effort)。
  extra?: Record<string, unknown>;
}
