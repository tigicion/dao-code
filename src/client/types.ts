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

// ---- token 用量(含 DeepSeek 扁平 cache 字段;prompt_tokens = hit + miss)----
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

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
  // 流式 usage 回调:收到 [DONE] 前那个 usage chunk 时调用(cache 命中率埋点用)。
  onUsage?: (usage: Usage) => void;
  // 中途取消信号(ESC/超时):abort 后 fetch 与流读取被中断,生成器返回已累积的部分消息而非抛错。
  signal?: AbortSignal;
}
