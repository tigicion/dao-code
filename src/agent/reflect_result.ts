// 反思器 fork 的返回:进展反思(advisory)+ 记忆抽取(memories),两段【独立容错】——
// 一段坏不拖累另一段。解析永不抛:坏到底就返回安全默认(什么都不做,不注入不丢)。

const MEM_TYPES = ["user", "feedback", "procedural", "semantic", "episodic"] as const;
export type ReflectMemType = (typeof MEM_TYPES)[number];

export interface ReflectMem {
  title: string;
  text: string;
  type: ReflectMemType;
  importance?: number;
  confidence?: number;
  source?: string;
  mergeInto?: string | null; // 命中则合并进该 title 的已有记忆
}

// 纠错:被本轮实测推翻或需修订的【旧记忆】。supersede=作废整条;revise=用 newText 替换。
export interface Correction {
  target: string; // 命中旧记忆的 title(或可辨识的事实串)
  action: "supersede" | "revise";
  newText?: string; // revise 必给:替换后的完整事实
  reason: string;
}

export interface ReflectResult {
  onTrack: boolean;
  advisory: string | null;
  memories: ReflectMem[];
  // 可观测性:无论在轨与否,模型都给一句话复述「在做什么 + 为何判这个 onTrack」。
  // onTrack=true 时 advisory 被强制丢弃(消噪),note 仍保留 → 事后能区分"认真审视判在轨" vs "橡皮章"。
  note?: string;
  // 纠错闭环:被实测推翻的旧记忆(作废/修订)。
  corrections: Correction[];
  // 被实测证实仍有效的旧记忆 title 列表。
  confirmed: string[];
}

const SAFE: ReflectResult = { onTrack: true, advisory: null, memories: [], note: undefined, corrections: [], confirmed: [] };

// 从模型原始输出里抠出 JSON 对象(去围栏 + 取首个 {...})。
function extractObject(s: string): Record<string, unknown> | null {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? (fence[1] ?? s) : s;
  const m = body.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseMem(x: unknown): ReflectMem | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const title = typeof o.title === "string" ? o.title.trim() : "";
  const text = typeof o.text === "string" ? o.text.trim() : "";
  const type = o.type;
  if (!title || !text || typeof type !== "string" || !MEM_TYPES.includes(type as ReflectMemType)) return null;
  const mem: ReflectMem = { title, text, type: type as ReflectMemType };
  if (typeof o.importance === "number") mem.importance = o.importance;
  if (typeof o.confidence === "number") mem.confidence = o.confidence;
  if (typeof o.source === "string" && o.source.trim()) mem.source = o.source.trim();
  if (typeof o.mergeInto === "string" && o.mergeInto.trim()) mem.mergeInto = o.mergeInto.trim();
  return mem;
}

// 纠错段:逐条独立降级。revise 无 newText 丢、action 非 supersede/revise 丢、无 target 丢。
function parseCorrection(x: unknown): Correction | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const target = typeof o.target === "string" ? o.target.trim() : "";
  const action = o.action;
  if (!target || (action !== "supersede" && action !== "revise")) return null;
  const c: Correction = { target, action, reason: typeof o.reason === "string" ? o.reason.trim() : "" };
  if (action === "revise") {
    const nt = typeof o.newText === "string" ? o.newText.trim() : "";
    if (!nt) return null; // revise 必须给 newText
    c.newText = nt;
  }
  return c;
}

export function parseReflectResult(raw: string): ReflectResult {
  const obj = extractObject(raw);
  if (!obj) return { ...SAFE };

  // 记忆段:逐条独立降级(坏条目丢、好条目留)。
  const memories = Array.isArray(obj.memories)
    ? (obj.memories.map(parseMem).filter(Boolean) as ReflectMem[])
    : [];

  // advisory 段:必须是非空字符串才算有;否则降级 null。
  const advisoryRaw = typeof obj.advisory === "string" && obj.advisory.trim() ? obj.advisory.trim() : null;

  // onTrack:显式 boolean 优先;缺失则按"有无 advisory"推断。
  const onTrack = typeof obj.onTrack === "boolean" ? obj.onTrack : advisoryRaw === null;

  // onTrack 为真时强制不出 advisory(消灭"在轨继续"噪音)。
  const advisory = onTrack ? null : advisoryRaw;

  // note:一句话复述(可观测,不注入主对话)。缺失则降级 undefined。
  const note = typeof obj.note === "string" && obj.note.trim() ? obj.note.trim() : undefined;

  // 纠错段:逐条独立降级(坏条目丢)。
  const corrections = Array.isArray(obj.corrections)
    ? (obj.corrections.map(parseCorrection).filter(Boolean) as Correction[])
    : [];

  // confirmed:过滤空串,trim 后留非空。
  const confirmed = Array.isArray(obj.confirmed)
    ? obj.confirmed.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim())
    : [];

  return { onTrack, advisory, memories, note, corrections, confirmed };
}
