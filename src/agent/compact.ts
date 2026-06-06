import type { ChatMessage } from "../client/types.js";

// 粗估 token:中英混排约 3 字符/token;统计 content 与 assistant 的 tool_calls。
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        chars += tc.function.name.length + tc.function.arguments.length;
      }
    }
  }
  return Math.ceil(chars / 3);
}

export function shouldCompact(messages: ChatMessage[], maxTokens: number, ratio = 0.85): boolean {
  return estimateTokens(messages) >= maxTokens * ratio;
}

export interface CompactOptions {
  keepRecentTurns: number; // 保留最近多少个 user 轮的原文
  summarize: (messages: ChatMessage[]) => Promise<string>;
}

// 压缩:保留 messages[0](系统前缀+记忆)+ 旧对话摘要 + 最近 N 轮原文。
// 按 user 消息切轮,保证保留的轮里 assistant↔tool 序列完整。
export async function compactMessages(
  messages: ChatMessage[],
  opts: CompactOptions,
): Promise<ChatMessage[]> {
  if (messages.length === 0) return messages;
  const system = messages[0]!;
  const rest = messages.slice(1);

  const userIdx: number[] = [];
  rest.forEach((m, i) => {
    if (m.role === "user") userIdx.push(i);
  });
  if (userIdx.length <= opts.keepRecentTurns) return messages;

  const tailStart = userIdx[userIdx.length - opts.keepRecentTurns]!;
  const toSummarize = rest.slice(0, tailStart);
  const tail = rest.slice(tailStart);
  if (toSummarize.length === 0) return messages;

  const summary = await opts.summarize(toSummarize);
  const summaryMsg: ChatMessage = {
    role: "system",
    content: `[早期对话摘要]\n${summary}`,
  };
  return [system, summaryMsg, ...tail];
}
