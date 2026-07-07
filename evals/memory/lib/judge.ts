// LLM 评审器:把 rubric 提示喂给真实模型,强制 JSON,容错解析。非确定性靠 K 次多数票(judgeBool)压。
// streamChat 注入:单测用 fakeStream,跑批用 src 的真实 streamChat。
import type { EvalConfig } from "./types.js";
import { majorityVote } from "./metrics.js";

export function parseJudgeJson(raw: string): Record<string, unknown> | null {
  const i = raw.indexOf("{"); const j = raw.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(raw.slice(i, j + 1)) as Record<string, unknown>; } catch { return null; }
}

export async function judgeOnce(p: { streamChat: (o: any) => AsyncGenerator<any, any>; cfg: EvalConfig; prompt: string }): Promise<Record<string, unknown> | null> {
  const gen = p.streamChat({
    baseUrl: p.cfg.baseUrl, apiKey: p.cfg.apiKey, model: p.cfg.model,
    messages: [{ role: "user", content: p.prompt }],
    extra: { thinking: { type: "disabled" }, temperature: 0 },
  });
  let out = ""; let r = await gen.next();
  while (!r.done) { if (r.value?.kind === "content") out += r.value.text; r = await gen.next(); }
  if (!out && typeof r.value?.content === "string") out = r.value.content;
  return parseJudgeJson(out);
}

export async function judgeBool(
  p: { streamChat: (o: any) => AsyncGenerator<any, any>; cfg: EvalConfig; prompt: string; key: string },
  K: number,
): Promise<{ value: boolean; agreement: number }> {
  const votes: boolean[] = [];
  for (let k = 0; k < K; k++) {
    const j = await judgeOnce({ streamChat: p.streamChat, cfg: p.cfg, prompt: p.prompt });
    votes.push(!!(j && j[p.key] === true));
  }
  return majorityVote(votes);
}

export function factCoveredPrompt(fact: { text: string; type: string; scope: string }, extracted: { title?: string; text: string }[]): string {
  const list = extracted.map((m, i) => `${i + 1}. 标题:${m.title ?? "(无)"} | 正文:${m.text}`).join("\n") || "(本会话没抽出任何记忆)";
  return `判断下面这条【金标事实】是否被任一【抽出记忆】语义覆盖(表述不同但同一事实即算覆盖)。\n` +
    `金标事实:${fact.text}\n\n抽出记忆:\n${list}\n\n` +
    `只输出 JSON:{"covered": true/false, "byTitle": "命中的标题或null", "why": "一句话理由"}`;
}

export function memoryQualityPrompt(memory: { title?: string; text: string; type?: string }): string {
  return `给这条抽出记忆按四维度各打 0-1 分:\n` +
    `记忆:标题=${memory.title ?? "(无)"} 类型=${memory.type ?? "?"} 正文=${memory.text}\n\n` +
    `维度:durable(是否跨会话耐久,非一次性)、typeScopeCorrect(type 与作用域是否合理)、notCatalogDump(是否非目录倾倒/非显而易见)、actionable(下次能否据此行动)。\n` +
    `只输出 JSON:{"durable":0-1,"typeScopeCorrect":0-1,"notCatalogDump":0-1,"actionable":0-1,"why":"一句话"}`;
}

export function relevancePrompt(task: string, memoryText: string): string {
  return `判断这条记忆对当前任务是否【真正相关】(能影响怎么做这个任务)。\n任务:${task}\n记忆:${memoryText}\n\n只输出 JSON:{"relevant": true/false, "why": "一句话"}`;
}

// pull 轴专用:只给标题(不给正文),判断"看到这个任务,你会不会主动去 memory_read 这条记忆的全文"。
// 用来量化"仅索引"策略下,标题本身的信号是否足以触发正确的检索决策——这是 push(全文常驻)vs
// pull(仅索引、按需读)两种召回策略的核心分歧点。
export function pullWorthyPrompt(task: string, title: string): string {
  return `你是一个 AI 编程助手,手头只有一份【记忆标题索引】(没有正文)。判断:面对下面这个任务,你会不会主动调用 memory_read 去读这条记忆的全文?\n` +
    `任务:${task}\n记忆标题:${title}\n\n只输出 JSON:{"wouldRead": true/false, "why": "一句话理由"}`;
}
