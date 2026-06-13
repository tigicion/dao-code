import type { Memory, MemoryType } from "./types.js";
import { newMemory } from "./types.js";

const SYS = `你是记忆蒸馏器。从对话里抽取值得【跨会话长期记住】的事实,按下面 5 种 type 准确归类——type 决定它存到哪一层(用户级 / 知识库 / 项目级),选错会污染全局,务必慎重。

- type=user(关于用户本人,最高价值):用户的环境/技术栈/水平/习惯、喜好、目标与背后的为什么;也可记你合理推断、用户没明说的(confidence 设低,如 0.4–0.6)。必须是【跨项目对这个人都成立】的,不是某项目里的一次现象。
- type=feedback(对你工作方式的【通用】指导):用户纠正(别这么做)或确认(这么做对)的协作方式。text 先写规则,再接"为什么:…"和"怎么用:…"。importance 7–9。必须跨项目通用,不是某项目的一次性要求。
- type=procedural(跨项目可复用的技术知识):框架/工具链/平台的通用坑或定式,换个项目仍适用(如"macOS 无 bundle 启 GUI 需 setActivationPolicy")。
- type=semantic(本项目的稳定事实):仅适用于当前项目——架构、技术选型、关键决定、目录/数据流。
- type=episodic(本项目的进展):推进到哪步、做了什么决定、下一步。text 含项目名、能独立读懂。importance 6–8。

【绝不要记】(噪音或会污染全局):
- 一次性/瞬时状态与情绪(如"用户对某功能反复失败不满")、本次会话的临时调试过程。
- 把【某项目专属】的事实写成 user/feedback——那应是 semantic/episodic。
- 把【dao 自身(你这个 coding agent)的实现细节/bug/工具行为】当成"用户偏好"——那不是关于用户的事实,不要记。
- 显而易见、或项目代码里已写明、读一眼就知道的。
- 【产品目录倾倒】复述工具/技能/命令的名字与用途清单——如"用户使用 X 技能做 Y""用户使用 X 工具(原 Y)""技能库里有 N 个技能""工具名从 X 改为 Y"。这些是产品自带、可发现的目录,不是关于用户的事实;哪怕这次用到了某技能,也不要为"用过它"本身记一条。每个技能/工具记一条 = 噪音。

只输出 JSON 数组,每项 {text(一句话), type(user|feedback|semantic|procedural|episodic), importance(1-10), confidence(0-1,可选), source(可选)}。
source 只在该事实从某真实文件/代码推导出来时填路径(如 "package.json#packageManager");user 类或无代码出处的一律省略,不要填"用户告知""推断"之类。
只保留耐久、可泛化的;忽略一次性细节与寒暄。无可记则输出 []。只输出 JSON,不要其它文字。`;

// 后备过滤(不依赖模型):拦截"产品目录倾倒"式条目——逐个技能/工具/命令的名字与用途清单,
// 这类是 dao 自带、可发现的目录,不是关于用户的事实。是 prompt 约束之外的 defense-in-depth。
const CATALOG_PATTERNS = [
  /使用\s*[\w./-]+\s*(技能|工具)/, // "使用 X 技能" / "使用 grep_files 工具"
  /\d+\s*个技能/, // "包含 31 个技能的技能库"
  /工具名.*改为/, // "工具名从 Task 改为 agent" 这类改名清单
];
export function isCatalogNoise(text: string): boolean {
  return CATALOG_PATTERNS.some((p) => p.test(text));
}

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
  const dbg = !!process.env.DAO_DEBUG_MEMORY;
  if (dbg) console.error(`[distill] 模型原始输出(${out.length} 字符):\n${out || "(空)"}`);
  const arr = extractJson(out);
  if (!Array.isArray(arr)) { if (dbg) console.error("[distill] extractJson 未解析出数组 → 返回 []"); return []; }
  const valid = new Set<MemoryType>(["user", "feedback", "semantic", "procedural", "episodic"]);
  const mems: Memory[] = [];
  for (const it of arr) {
    if (!it || typeof it.text !== "string" || !valid.has(it.type)) continue;
    const importance = typeof it.importance === "number" ? it.importance : 5;
    if (importance < 4) continue; // salience 门
    if (isCatalogNoise(it.text)) { if (dbg) console.error(`[distill] 目录倾倒后备过滤丢弃:${it.text}`); continue; }
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
