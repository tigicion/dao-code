// ---- 对话消息 ----
// OpenAI 兼容的多模态 content:纯文本仍用 string(绝大多数场景),图片走 ContentPart[] 数组。
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }; // data:image/png;base64,... 格式内联

export interface SystemMessage {
  role: "system";
  content: string;
}
export interface UserMessage {
  role: "user";
  content: string | ContentPart[];
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
  // 思维链(仅落盘/事后分析用,如 RHO/AHE 论文分析轨迹时读取):从 API 的 reasoning_content 累积而来,
  // 绝不随 messages 一起重发给 API(client.ts 组包请求体时会剥掉这个字段,只留 content/tool_calls)。
  reasoningContent?: string;
}
export interface ToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string | ContentPart[];
  /** 工具返回的图片数据(execute.ts 暂存,loop.ts 据此在 tool messages 后注入 user image message) */
  imageData?: { base64: string; mediaType: string };
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
  // finish_reason 回调:每次拿到本轮最终 finish_reason 时调用(如 stop/length/content_filter)。
  // 用途:检测 content_filter(服务端内容过滤拦截,返回一句风格不像模型本身的通用拒答文案,
  // 语义上跟"模型不知道怎么答"完全不同,不该被当成普通完成——真实撞见过 password-recovery/
  // protein-assembly 两个任务命中,当时毫无痕迹,只能靠事后手工 replay 复现才查出真相)。
  onFinishReason?: (reason: string) => void;
  // 推理耗尽预算回调:finish_reason=length 但 content 全程为空(整个输出预算被 reasoning_content
  // 吃光,还没开始写最终回答/工具调用就被截断)。这种情况下 content 为空,现有续写恢复机制
  // (要求 content 非空才触发)无法处理,这一轮真实的思考会被直接丢弃——真实撞见过 terminal-bench
  // gpt2-codegolf/model-extraction-relu-logits 两题,均以"连续两次空响应,结束本轮"告终,900s+
  // 预算只用了几秒钟。上层(loop.ts)据此在重试前注入收敛提示,而不是盲目原样重发。
  onEmptyTruncation?: () => void;
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
