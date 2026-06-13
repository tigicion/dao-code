import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// 技能触发审计:每"轮"(一条用户消息=一 round)记录两类事件,事后判断触发好坏与原因,指导优化。
//  - offered:本轮发现(relevantSkills)给模型的候选 + 分数(它"看见了什么")
//  - loaded :模型本轮真的用 skill 工具加载了哪条(它"采纳了什么")
// 落盘 <sessionDir>/skill-trace.jsonl。DAO_SKILL_AUDIT=0 → 零成本 no-op。

export interface SkillCandidate { name: string; score: number }
export type SkillTraceEvent =
  | { kind: "offered"; round: number; ts: number; input: string; candidates: SkillCandidate[] }
  | { kind: "loaded"; round: number; ts: number; name: string };

export interface SkillAuditSink {
  offered(round: number, input: string, candidates: SkillCandidate[]): void;
  loaded(round: number, name: string): void;
}

const NOOP: SkillAuditSink = { offered() {}, loaded() {} };

export function createSkillAuditSink(sessionDir: string, env: NodeJS.ProcessEnv = process.env): SkillAuditSink {
  if (env.DAO_SKILL_AUDIT === "0") return NOOP;
  const file = path.join(sessionDir, "skill-trace.jsonl");
  try { mkdirSync(sessionDir, { recursive: true }); } catch { /* 落盘时再兜底 */ }
  const write = (ev: SkillTraceEvent) => {
    try { appendFileSync(file, JSON.stringify(ev) + "\n"); } catch { /* 观测落盘失败不影响主流程 */ }
  };
  return {
    offered: (round, input, candidates) => write({ kind: "offered", round, ts: Date.now(), input: input.slice(0, 200), candidates }),
    loaded: (round, name) => write({ kind: "loaded", round, ts: Date.now(), name }),
  };
}

// ---- 汇总:把事件流压成每技能的触发统计,给出"好坏"指标与"原因"线索 ----

export interface SkillStat {
  name: string;
  offered: number;    // 被发现提示的轮数
  loaded: number;     // 被模型加载的轮数
  offeredNotUsed: number; // 提示了却没加载 → 疑似漏报(模型忽略)
  loadedNoOffer: number;  // 没提示却被加载 → 发现召回漏了它(模型自己找到的)
  maxScore: number;   // 历史最高发现分(分低=发现机制召回弱)
  loadRate: number;   // loaded / offered(被看见时的采纳率)
}

// 纯函数:由事件数组算每技能统计(按 round 去重计数)。旧 trace 里的 activated 事件被忽略(已移除条件技能)。
export function summarizeSkillTrace(events: SkillTraceEvent[]): SkillStat[] {
  type Acc = { offered: Set<number>; loaded: Set<number>; maxScore: number };
  const m = new Map<string, Acc>();
  const get = (n: string): Acc => { let a = m.get(n); if (!a) { a = { offered: new Set(), loaded: new Set(), maxScore: 0 }; m.set(n, a); } return a; };
  for (const e of events) {
    if (e.kind === "offered") for (const c of e.candidates) { const a = get(c.name); a.offered.add(e.round); a.maxScore = Math.max(a.maxScore, c.score); }
    else if (e.kind === "loaded") get(e.name).loaded.add(e.round);
  }
  const stats: SkillStat[] = [];
  for (const [name, a] of m) {
    const offeredNotUsed = [...a.offered].filter((r) => !a.loaded.has(r)).length;
    const loadedNoOffer = [...a.loaded].filter((r) => !a.offered.has(r)).length;
    stats.push({
      name,
      offered: a.offered.size, loaded: a.loaded.size,
      offeredNotUsed, loadedNoOffer, maxScore: a.maxScore,
      loadRate: a.offered.size ? a.loaded.size / a.offered.size : 0,
    });
  }
  // 排序:最该关注的在前——提示多但采纳率低(疑似漏报/发现噪声)。
  return stats.sort((x, y) => y.offeredNotUsed - x.offeredNotUsed || y.offered - x.offered);
}

// 读所有会话的 skill-trace.jsonl(跨会话聚合,便于长期优化),解析成事件数组。坏行跳过。
export function readAllSkillTraces(sessionsRoot: string): SkillTraceEvent[] {
  const events: SkillTraceEvent[] = [];
  let dirs: string[];
  try { dirs = readdirSync(sessionsRoot); } catch { return events; }
  for (const d of dirs) {
    const f = path.join(sessionsRoot, d, "skill-trace.jsonl");
    let raw: string;
    try { raw = readFileSync(f, "utf8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line) as SkillTraceEvent); } catch { /* 坏行跳过 */ }
    }
  }
  return events;
}

// 渲染汇总为可读报告(/skills audit 用)。
export function formatSkillReport(stats: SkillStat[]): string {
  if (stats.length === 0) return "暂无技能触发记录(跑几轮带技能的任务后再看;DAO_SKILL_AUDIT=0 会关闭记录)。";
  const rows = stats.map((s) =>
    `  ${s.name.padEnd(20)} 提示${s.offered} 加载${s.loaded} ` +
    `采纳率${(s.loadRate * 100).toFixed(0)}% 疑似漏报${s.offeredNotUsed} 漏召回${s.loadedNoOffer} 峰值分${s.maxScore}`,
  );
  return [
    "技能触发审计(跨会话聚合):",
    "  指标 — 采纳率=提示时被加载占比;疑似漏报=提示了却没用(模型忽略);漏召回=没提示却被加载(发现没召回到)",
    ...rows,
  ].join("\n");
}
