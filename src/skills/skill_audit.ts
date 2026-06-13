import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { auditEnabled } from "../session/audit_switch.js";

// 技能加载审计:每"轮"(一条用户消息=一 round)记录模型用 skill 工具加载了哪条。
// discovery(打分预筛)已移除——技能统一走常驻 name+description,由模型自主判断、按需 skill 加载。
// 故此处只记【模型实际加载了什么】;"该加载却没加载"需上下文感知的 LLM 裁判,另立 eval。
// 落盘 <sessionDir>/skill-trace.jsonl。DAO_SKILL_AUDIT=0 → 零成本 no-op。

export type SkillTraceEvent = { kind: "loaded"; round: number; ts: number; name: string };

export interface SkillAuditSink {
  loaded(round: number, name: string): void;
}

const NOOP: SkillAuditSink = { loaded() {} };

export function createSkillAuditSink(sessionDir: string, env: NodeJS.ProcessEnv = process.env): SkillAuditSink {
  if (!auditEnabled(env, "SKILL")) return NOOP;
  const file = path.join(sessionDir, "skill-trace.jsonl");
  try { mkdirSync(sessionDir, { recursive: true }); } catch { /* 落盘时再兜底 */ }
  const write = (ev: SkillTraceEvent) => {
    try { appendFileSync(file, JSON.stringify(ev) + "\n"); } catch { /* 观测落盘失败不影响主流程 */ }
  };
  return {
    loaded: (round, name) => write({ kind: "loaded", round, ts: Date.now(), name }),
  };
}

// ---- 汇总:把加载事件压成每技能统计 ----

export interface SkillStat {
  name: string;
  loaded: number; // 被加载的轮数(按 round 去重)
  total: number;  // 总加载次数(含同轮重复)
}

// 纯函数:由事件数组算每技能加载统计。旧 trace 里的 offered/activated 事件被忽略(机制已移除)。
export function summarizeSkillTrace(events: SkillTraceEvent[]): SkillStat[] {
  const m = new Map<string, { rounds: Set<number>; total: number }>();
  const get = (n: string) => { let a = m.get(n); if (!a) { a = { rounds: new Set(), total: 0 }; m.set(n, a); } return a; };
  for (const e of events) {
    if (e.kind === "loaded") { const a = get(e.name); a.rounds.add(e.round); a.total++; }
  }
  const stats: SkillStat[] = [];
  for (const [name, a] of m) stats.push({ name, loaded: a.rounds.size, total: a.total });
  // 最常被加载的在前(加载轮数,其次总次数)。
  return stats.sort((x, y) => y.loaded - x.loaded || y.total - x.total);
}

// 读所有会话的 skill-trace.jsonl(跨会话聚合),解析成事件数组。坏行/旧事件类型跳过。
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
      try {
        const ev = JSON.parse(line) as { kind?: string };
        if (ev.kind === "loaded") events.push(ev as SkillTraceEvent); // 旧 offered/activated 行忽略
      } catch { /* 坏行跳过 */ }
    }
  }
  return events;
}

// 渲染加载统计为可读报告。
export function formatSkillReport(stats: SkillStat[]): string {
  if (stats.length === 0) return "暂无技能加载记录(跑几轮带技能的任务后再看;DAO_SKILL_AUDIT=0 会关闭记录)。";
  const rows = stats.map((s) => `  ${s.name.padEnd(20)} 加载轮数 ${s.loaded} · 总次数 ${s.total}`);
  return [
    "技能加载审计(跨会话聚合):",
    "  记的是模型实际加载了哪些 skill;'该加载却没加载'需 LLM 裁判判断(本表不含)。",
    ...rows,
  ].join("\n");
}
