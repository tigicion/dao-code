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
  /** 用于错误提示,如 "deepseek" / "volcengine";省略则用 baseUrl */
  provider?: string;
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
  // 流空闲看门狗:超过这么多毫秒没收到任何数据(连接挂起/模型停滞)→ 中断本次流并抛清晰错误,
  // 防止单回合永久卡死(只能靠 ESC 手动停)。默认 DAO_STREAM_IDLE_MS 或 120000。
  idleTimeoutMs?: number;
  // 连接瞬断重试:产出任何内容之前遇到可重试网络错误(socket 断开等)时,最多重试几次。默认 2。
  maxRetries?: number;
  // 重试退避基数(毫秒);第 n 次等待 retryDelayMs*n。默认 600。
  retryDelayMs?: number;
  // 背景查询(子代理/后台任务):遇 529 过载立即上抛、不重试,防并行子代理重试放大级联。
  background?: boolean;
}
