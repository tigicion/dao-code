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

// 可重现的只读工具:其结果旧了可清掉(需要时重新获取);写/执行结果是关键状态,保留。
const REPRODUCIBLE_TOOLS = new Set(["read_file", "list_dir", "grep_files", "file_search", "fetch_url", "web_search", "memory_search", "skill"]);
const CLEARED_MARK = "[旧工具结果已清理,需要时可重新获取]";

// 【缓存约束】microcompact 会改动旧消息 → 破坏 DeepSeek 前缀缓存。只可在 compactMessages 内调用
// (那时压缩已重置缓存,无额外代价);切勿当作"每回合独立裁剪",否则会在本可命中缓存的回合废掉缓存、净亏。
// microcompact:把【最近 keepRecentTurns 个 user 轮之前】的可重现工具结果就地替换为标记,
// 大幅削 token 而不丢关键状态(写/执行结果保留)。纯函数,返回新数组。
export function microcompactMessages(messages: ChatMessage[], keepRecentTurns = 2): ChatMessage[] {
  const userIdx: number[] = [];
  messages.forEach((m, i) => { if (m.role === "user") userIdx.push(i); });
  if (userIdx.length <= keepRecentTurns) return messages; // 太短,不动
  const cutoff = userIdx[userIdx.length - keepRecentTurns]!;
  const nameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) for (const tc of m.tool_calls) nameById.set(tc.id, tc.function.name);
  }
  return messages.map((m, i) => {
    if (i >= cutoff) return m; // 近期原样保留
    if (m.role === "tool" && m.tool_call_id && typeof m.content === "string" && m.content !== CLEARED_MARK) {
      const name = nameById.get(m.tool_call_id);
      if (name && REPRODUCIBLE_TOOLS.has(name)) return { ...m, content: CLEARED_MARK };
    }
    return m;
  });
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
  pinned?: string, // 压缩后重注入的"活的任务清单",使计划穿越压缩、防长任务目标漂移
): Promise<ChatMessage[]> {
  if (messages.length === 0) return messages;
  // 先 microcompact:清掉旧的可重现工具结果,缩小待摘要部分(对标 CC 压缩前置步骤)。
  messages = microcompactMessages(messages, opts.keepRecentTurns);
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
    content: `[早期对话摘要——上下文超限已压缩,以下是早段对话的摘要]\n${summary}\n\n从中断处直接继续,不要复述摘要、不要寒暄,像没中断过一样接着上一个任务。`,
  };
  const out: ChatMessage[] = [system, summaryMsg];
  if (pinned && pinned.trim()) out.push({ role: "system", content: `[当前任务清单(请据此继续,勿偏离)]\n${pinned}` });
  return [...out, ...tail];
}
