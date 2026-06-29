// 记忆合并 pass:对一个作用域的全部 live 记忆做一次推理重合并,清理跨会话累积的重叠/矛盾。
// 纯函数(parse/gate/prompt)与 LLM runner(见 consolidate())分离,便于测试。
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Memory } from "./types.js";
import { upsertMemory, supersedeMemory, slug, loadAllMemories } from "./store.js";
import { newMemory } from "./types.js";

export interface ConsolidationGroup {
  canonical: { title: string; text: string; type?: string; importance?: number; confidence?: number; source?: string };
  supersede: string[]; // 被并掉的旧记忆 name
  reason: string;
}
export interface ConsolidationPlan { groups: ConsolidationGroup[] }

const EMPTY: ConsolidationPlan = { groups: [] };

function extractObject(s: string): Record<string, unknown> | null {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? (fence[1] ?? s) : s;
  const m = body.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { const v = JSON.parse(m[0]); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; }
  catch { return null; }
}

function parseGroup(x: unknown): ConsolidationGroup | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const c = o.canonical;
  if (!c || typeof c !== "object") return null;
  const cc = c as Record<string, unknown>;
  const title = typeof cc.title === "string" ? cc.title.trim() : "";
  const text = typeof cc.text === "string" ? cc.text.trim() : "";
  if (!text) return null; // canonical 必须有正文
  if (!Array.isArray(o.supersede)) return null;
  const supersede = o.supersede.filter((s): s is string => typeof s === "string" && !!s.trim());
  const g: ConsolidationGroup = {
    canonical: { title, text },
    supersede,
    reason: typeof o.reason === "string" ? o.reason.trim() : "",
  };
  if (typeof cc.type === "string") g.canonical.type = cc.type;
  if (typeof cc.importance === "number") g.canonical.importance = cc.importance;
  if (typeof cc.confidence === "number") g.canonical.confidence = cc.confidence;
  if (typeof cc.source === "string" && cc.source.trim()) g.canonical.source = cc.source.trim();
  return g;
}

export function parseConsolidationPlan(raw: string): ConsolidationPlan {
  const obj = extractObject(raw);
  if (!obj || !Array.isArray(obj.groups)) return { ...EMPTY };
  return { groups: obj.groups.map(parseGroup).filter(Boolean) as ConsolidationGroup[] };
}

export type ConsolScope = "user" | "knowledge" | "project";
export interface ConsolCfg { days: number; min: number; force: "aggressive" | "medium" | "conservative" }

export function consolidationCfg(scope: ConsolScope): ConsolCfg {
  if (scope === "user") return { days: 3, min: 12, force: "aggressive" };
  if (scope === "knowledge") return { days: 3, min: 15, force: "medium" };
  return { days: 3, min: 20, force: "conservative" };
}

const DAY_MS = 86_400_000;
export function shouldConsolidate(lastMs: number, liveCount: number, now: number, cfg: ConsolCfg): boolean {
  if (liveCount < cfg.min) return false;
  return now - lastMs >= cfg.days * DAY_MS;
}

const FORCE_LINE: Record<ConsolCfg["force"], string> = {
  aggressive: "积极:同一画像维度的多条收敛成一条规范记忆。",
  medium: "中等:同一技术事实/知识点的重复条目去重合并。",
  conservative: "保守:只合并【明确冗余或直接矛盾】的条目(如两条讲同一件事的进度快照);异质事实一律保留,拿不准就不合并。",
};

export function buildConsolidatePrompt(
  scope: ConsolScope,
  mems: { name: string; title?: string; text: string; type: string; source?: string }[],
): string {
  const list = mems.map((m) => `- name=${m.name} | type=${m.type}${m.source ? " | source=" + m.source : ""} | ${m.title ?? ""}: ${m.text}`).join("\n");
  return `你在做记忆库的【合并整理】。下面是 ${scope} 作用域的全部生效记忆。找出重叠/冗余/矛盾的簇并合并。只输出一个 JSON 对象,无其它文字。

力度:${FORCE_LINE[consolidationCfg(scope).force]}
纪律:
- 不跨 source 合并(user_stated 与 inferred 永不混)。
- 每簇产出一条 canonical(合成后的规范全文,取最高 confidence;矛盾时偏向 user_stated 与更新者),并列出被它取代的旧记忆 name 到 supersede。
- 每簇必须给 reason。无可合并 → groups: []。
- 保守优先:漏合并的代价远小于错合并污染全局。

记忆清单:
${list}

输出(严格 JSON):
{"groups":[{"canonical":{"title":"…","text":"合成后的完整规范正文","type":"user","importance":8,"confidence":0.85,"source":"inferred"},"supersede":["旧name1","旧name2"],"reason":"二者都讲 X,canonical 已涵盖"}]}`;
}

// LLM runner:把 buildConsolidatePrompt 的结果发给模型,流式读回文本,交 parseConsolidationPlan 解析。
// 任何异常 → {groups:[]}(合并失败绝不影响启动)。流式读取写法参考 unified_reflect.ts:84-93。
export interface ConsolidateInput {
  streamChat: (opts: any) => AsyncGenerator<any, any>;
  config: { baseUrl: string; apiKey: string };
  model: string;
  scope: ConsolScope;
  mems: { name: string; title?: string; text: string; type: string; source?: string }[];
  onUsage?: (u: unknown) => void;
}

export async function consolidate(p: ConsolidateInput): Promise<ConsolidationPlan> {
  const prompt = buildConsolidatePrompt(p.scope, p.mems);
  try {
    const gen = p.streamChat({
      baseUrl: p.config.baseUrl, apiKey: p.config.apiKey, model: p.model,
      messages: [{ role: "user", content: prompt }],
      extra: { thinking: { type: "disabled" }, temperature: 0 },
      ...(p.onUsage ? { onUsage: p.onUsage } : {}),
    });
    let out = ""; let r = await gen.next();
    while (!r.done) { if (r.value?.kind === "content") out += r.value.text; r = await gen.next(); }
    if (!out && typeof r.value?.content === "string") out = r.value.content;
    return parseConsolidationPlan(out);
  } catch {
    return { groups: [] }; // 合并失败绝不影响启动
  }
}

// 写回落地:canonical upsert 写盘;被并源 supersede 软删(validUntil=today,GC 7 天宽限后清)。
// canonical 的 name 用 slug(title);若与某 supersede 项同名,跳过对它的 supersede(它就是 canonical 本体)。
export async function applyConsolidationPlan(
  dir: string,
  plan: ConsolidationPlan,
  existing: Memory[],
  today: string,
): Promise<{ merged: number; superseded: number }> {
  let merged = 0, superseded = 0;
  for (const g of plan.groups) {
    const cand = newMemory({
      name: slug(g.canonical.title || g.canonical.text),
      title: g.canonical.title,
      text: g.canonical.text,
      type: (g.canonical.type as Memory["type"]) || "user",
      today,
      importance: g.canonical.importance,
      confidence: g.canonical.confidence,
      source: g.canonical.source,
    });
    await upsertMemory(dir, cand, existing);
    merged++;
    for (const oldName of g.supersede) {
      if (oldName === cand.name) continue; // 别把 canonical 本体 supersede 掉
      const before = existing.find((m) => m.name === oldName);
      await supersedeMemory(dir, oldName, cand.name, today);
      if (before) superseded++;
    }
  }
  return { merged, superseded };
}

export interface MaybeConsolidateDeps {
  dir: string;
  scope: ConsolScope;
  today: string;
  now: number;
  streamChat: ConsolidateInput["streamChat"];
  config: { baseUrl: string; apiKey: string };
  model: string;
  onAudit?: (e: { scope: string; groups: number; superseded: number; reasons: string[] }) => void;
  onUsage?: (u: unknown) => void;
}

// 启动期 gated 合并:仅该作用域 dir;未达天数/条数则跳过。失败绝不影响启动。
export async function maybeConsolidate(deps: MaybeConsolidateDeps): Promise<void> {
  const cfg = consolidationCfg(deps.scope);
  const marker = path.join(deps.dir, ".last-consolidation");
  try {
    const existing = await loadAllMemories(deps.dir, deps.dir + "-none-other"); // 只读本 dir 的 active
    if (existing.length < cfg.min) return;
    const lastMs = Number(await fs.readFile(marker, "utf8").catch(() => "0"));
    if (!shouldConsolidate(lastMs, existing.length, deps.now, cfg)) return;

    const mems = existing.map((m) => ({ name: m.name, title: m.title, text: m.text, type: m.type, source: m.source }));
    const plan = await consolidate({ streamChat: deps.streamChat, config: deps.config, model: deps.model, scope: deps.scope, mems, ...(deps.onUsage ? { onUsage: deps.onUsage } : {}) });

    const r = await applyConsolidationPlan(deps.dir, plan, existing, deps.today);
    deps.onAudit?.({ scope: deps.scope, groups: r.merged, superseded: r.superseded, reasons: plan.groups.map((g) => g.reason) });

    await fs.mkdir(deps.dir, { recursive: true });
    await fs.writeFile(marker, String(deps.now), "utf8");
  } catch { /* 合并失败不影响启动 */ }
}
