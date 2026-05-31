import type { Memory, MemoryType } from "./types.js";
import { newMemory } from "./types.js";

const SYS = `你是记忆蒸馏器。从给定对话里抽取值得跨会话长期记住的事实,**最看重"关于用户这个人"的信息**:用户的环境/技术栈/水平/习惯(信息)、喜好(偏好)、目标与背后的为什么(意图),以及你能合理推断、但用户没明说的信息或意图(这类 type=user 且 confidence 设低,如 0.4–0.6)。也可记通用可复用规则(procedural)与稳定项目事实(semantic)。
另有两类高价值记忆,出现时必须抽取:
- type=feedback:用户对你工作方式的指导——纠正(说了别这么做/不满意)或确认(说了这么做对)。text 先写规则本身,再接"为什么:…"和"怎么用:…"(知道为什么,边界情况才能自行判断是否适用)。importance 给 7–9。
- 项目进展(type=episodic):用户项目当前推进到哪一步、做了什么关键决定、下一步计划。text 要含项目名、能独立读懂(如"DAO CODE 已完成 X,下一步 Y")。importance 给 6–8。
只输出 JSON 数组,每项 {text(一句话), type(user|feedback|semantic|procedural|episodic), importance(1-10), confidence(0-1,可选), source(可选)}。
source 只在该事实是从某个真实文件/代码推导出来时填,且必须是文件路径(如 "package.json#packageManager");用户类事实(type=user)或任何没有代码出处的事实一律省略 source,不要填"用户告知""推断"之类的理由说明。
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
  // 只渲染真实对话:必须排除 system 消息——它含巨大的系统 prompt(工具/指令/记忆),
  // 既会把 flash 带偏,又会从开头吃满字符预算、把真正的用户对话挤掉。取最近 24000 字符。
  const rendered = p.messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role}: ${m.content ?? ""}`)
    .join("\n")
    .slice(-24000);
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
  const valid = new Set<MemoryType>(["user", "feedback", "semantic", "procedural", "episodic"]);
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
