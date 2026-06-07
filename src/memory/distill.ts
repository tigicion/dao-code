import type { Memory, MemoryType } from "./types.js";
import { newMemory } from "./types.js";

const SYS = `你是记忆蒸馏器。从给定对话里抽取值得跨会话长期记住的事实,**最看重"关于用户这个人"的信息**:用户的环境/技术栈/水平/习惯(信息)、喜好(偏好)、目标与背后的为什么(意图),以及你能合理推断、但用户没明说的信息或意图(这类 type=user 且 confidence 设低,如 0.4–0.6)。也可记通用可复用规则(procedural)与稳定项目事实(semantic)。
只输出 JSON 数组,每项 {text(一句话), type(user|semantic|procedural|episodic), importance(1-10), confidence(0-1,可选), source(可选,代码出处)}。
只保留耐久、可泛化的;忽略一次性细节与寒暄。无可记则输出 []。只输出 JSON,不要其它文字。`;

function extractJson(s: string): unknown {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? (fence[1] ?? s) : s;
  const m = body.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export async function distill(p: {
  streamChat: (opts: any) => AsyncGenerator<any, any>;
  config: { baseUrl: string; apiKey: string }; model: string;
  messages: { role: string; content: string | null }[]; today: string;
}): Promise<Memory[]> {
  const rendered = p.messages.map((m) => `${m.role}: ${m.content ?? ""}`).join("\n").slice(0, 24000);
  const gen = p.streamChat({
    baseUrl: p.config.baseUrl, apiKey: p.config.apiKey, model: p.model,
    messages: [{ role: "system", content: SYS }, { role: "user", content: rendered }],
    extra: { thinking: { type: "disabled" }, temperature: 0 },
  });
  let out = ""; let r = await gen.next();
  while (!r.done) { if (r.value?.kind === "content") out += r.value.text; r = await gen.next(); }
  if (!out && typeof r.value?.content === "string") out = r.value.content;
  const dbg = !!process.env.CODEDS_DEBUG_MEMORY;
  if (dbg) console.error(`[distill] 模型原始输出(${out.length} 字符):\n${out || "(空)"}`);
  const arr = extractJson(out);
  if (!Array.isArray(arr)) { if (dbg) console.error("[distill] extractJson 未解析出数组 → 返回 []"); return []; }
  const valid = new Set<MemoryType>(["user", "semantic", "procedural", "episodic"]);
  const mems: Memory[] = [];
  for (const it of arr) {
    if (!it || typeof it.text !== "string" || !valid.has(it.type)) continue;
    const importance = typeof it.importance === "number" ? it.importance : 5;
    if (importance < 4) continue; // salience 门
    mems.push(newMemory({
      name: it.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "mem",
      text: it.text, type: it.type, today: p.today, importance,
      confidence: typeof it.confidence === "number" ? it.confidence : undefined,
      source: typeof it.source === "string" ? it.source : undefined,
    }));
  }
  if (dbg) console.error(`[distill] 解析出候选 ${mems.length} 条(importance<4 已滤)`);
  return mems;
}
