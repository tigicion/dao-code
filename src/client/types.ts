// 发给 DeepSeek 的对话消息(M1 只用到 system/user/assistant)。
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// streamChat 逐块 yield 的类型化增量。M1 只关心 reasoning 与 content 文本。
export type StreamDelta =
  | { kind: "reasoning"; text: string }
  | { kind: "content"; text: string };

export interface StreamChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  // 注入 fetch,便于测试;默认用全局 fetch。
  fetchImpl?: typeof fetch;
  // 透传给 API 的额外字段(如 thinking、reasoning_effort),M1 先留口不强制。
  extra?: Record<string, unknown>;
}
