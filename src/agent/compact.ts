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
  summarize: (messages: ChatMessage[]) => Promise<string>;
}

// 压缩(整段摘要,无 verbatim tail):保留 messages[0](系统前缀+记忆)+ 一份覆盖其后【全部】对话的摘要
// + 可选的活任务清单 pin。
// 为何不再保留"最近 N 轮原文":压缩后前缀本就从【新摘要】处断开缓存,tail 落在冷区、留原文对缓存无益;
// 续接改由摘要的"当前工作/下一步(附原话引用)"小节承载(对标 CC 的整段摘要)。这也根除了"最近轮含大
// 工具输出 → tail 膨胀、压不动"的结构性问题,并让单 user 轮长任务也走同一条摘要路径(无需 microcompact)。
export async function compactMessages(
  messages: ChatMessage[],
  opts: CompactOptions,
  pinned?: string, // 压缩后重注入的"活的任务清单",使计划穿越压缩、防长任务目标漂移
): Promise<ChatMessage[]> {
  if (messages.length <= 1) return messages; // 只有 system(或空)→ 无可压
  const system = messages[0]!;
  const rest = messages.slice(1);

  const pinnedMsg = (): ChatMessage[] =>
    pinned && pinned.trim() ? [{ role: "system", content: `[当前任务清单(请据此继续,勿偏离)]\n${pinned}` }] : [];

  // ④ 增量压缩:若 rest 开头是【上次压缩留下的摘要】,把它的【文本】原样保留(不二次摘要 → 免转述磨损),
  // 只把其后新增的摘要拼上。重复压缩越来越便宜、且早期要点逐字不衰减。
  // 【缓存】不把旧摘要剔除再发——它在主对话热缓存前缀里,连它一起发([system, ...rest] 正是热缓存的前缀)
  // 才命中缓存;摘要器由 instruction 被告知勿重复它(见 index.ts)。
  const SUMMARY_MARK = "[早期对话摘要";
  let priorSummary = "";
  if (rest[0]?.role === "system" && typeof rest[0].content === "string" && rest[0].content.startsWith(SUMMARY_MARK)) {
    priorSummary = rest[0].content;
  }
  if (priorSummary && rest.length === 1) return messages; // 只剩旧摘要、无新内容 → 不动

  // L2.3 降级阶梯:摘要失败(模型挂/熔断打开)→ 硬截断兜底,绝不让"压缩本身"把长任务搞崩。
  let summary: string;
  try {
    summary = await opts.summarize([system, ...rest]); // 发 [system, ...全部对话]:整段摘要 + 命中主对话热缓存
  } catch {
    const marker: ChatMessage = {
      role: "system",
      content: `${priorSummary ? priorSummary + "\n\n" : ""}[早期对话已截断(摘要暂不可用):为继续任务保留了系统提示与任务清单,对话细节已舍弃。如缺关键背景,请向用户确认。]`,
    };
    return [system, marker, ...pinnedMsg()];
  }
  const merged = priorSummary
    ? `${priorSummary}\n\n[续·本次新增]\n${summary}` // 旧摘要保留 + 追加新增
    : `[早期对话摘要——上下文超限已压缩,以下是早段对话的摘要]\n${summary}\n\n从中断处直接继续,不要复述摘要、不要寒暄,像没中断过一样接着上一个任务。`;
  const summaryMsg: ChatMessage = { role: "system", content: merged };
  return [system, summaryMsg, ...pinnedMsg()];
}
