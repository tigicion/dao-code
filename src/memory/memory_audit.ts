import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { auditEnabled } from "../session/audit_switch.js";

// 记忆审计:召回(会话启动注入了什么)/写入(memory_write 新建 vs 合并)/蒸馏(退出抽取)。
// 落盘 <sessionDir>/memory-trace.jsonl。受总开关 DAO_AUDIT(默认开)/DAO_MEMORY_AUDIT 控制。
export type MemoryTraceEvent =
  | { kind: "recalled"; ts: number; injected: number; stale: number; changed: number; types: Record<string, number>; foreign?: number }
  | { kind: "wrote"; ts: number; type: string; merged: boolean }
  | { kind: "distilled"; ts: number; extracted: number; added: number; updated: number }
  // 统一反思器:每次跑一行(跳过的回合 ran=false)。note=模型一句话复述(可观测,尤其 onTrack=true 时用来判断是否真审视过)。
  | { kind: "reflected"; ts: number; ran: boolean; onTrack: boolean; advisoryInjected: boolean; memAdded: number; memMerged: number; interval: number; note?: string; corrected?: number; confirmed?: number }
  // 每条纠错落一行 reason 明细(可事后复盘"错纠污染全局"最大风险)。计数仍由 reflected 事件聚合,本事件只补 target/action/reason 明细。
  | { kind: "corrected"; ts: number; target: string; action: "supersede" | "revise"; reason: string }
  // 记忆合并 pass:一轮合并做了什么(scope=作用域,groups=合并组数,superseded=被取代的旧条目数,reasons=每组合并理由)。
  | { kind: "consolidated"; ts: number; scope: string; groups: number; superseded: number; reasons: string[] };

export interface MemoryAuditSink {
  recalled(injected: number, stale: number, changed: number, types: Record<string, number>, foreign?: number): void;
  wrote(type: string, merged: boolean): void;
  distilled(extracted: number, added: number, updated: number): void;
  reflected(e: { ran: boolean; onTrack: boolean; advisoryInjected: boolean; memAdded: number; memMerged: number; interval: number; note?: string; corrected?: number; confirmed?: number }): void;
  corrected(e: { target: string; action: "supersede" | "revise"; reason: string }): void;
  consolidated(e: { scope: string; groups: number; superseded: number; reasons: string[] }): void;
}

const NOOP: MemoryAuditSink = { recalled() {}, wrote() {}, distilled() {}, reflected() {}, corrected() {}, consolidated() {} };

export function createMemoryAuditSink(sessionDir: string, env: NodeJS.ProcessEnv = process.env): MemoryAuditSink {
  if (!auditEnabled(env, "MEMORY")) return NOOP;
  const file = path.join(sessionDir, "memory-trace.jsonl");
  try { mkdirSync(sessionDir, { recursive: true }); } catch { /* 落盘时再兜底 */ }
  const write = (ev: MemoryTraceEvent) => {
    try { appendFileSync(file, JSON.stringify(ev) + "\n"); } catch { /* 观测落盘失败不影响主流程 */ }
  };
  return {
    recalled: (injected, stale, changed, types, foreign) => write({ kind: "recalled", ts: Date.now(), injected, stale, changed, types, ...(foreign ? { foreign } : {}) }),
    wrote: (type, merged) => write({ kind: "wrote", ts: Date.now(), type, merged }),
    distilled: (extracted, added, updated) => write({ kind: "distilled", ts: Date.now(), extracted, added, updated }),
    reflected: (e) => write({ kind: "reflected", ts: Date.now(), ...e }),
    corrected: (e) => write({ kind: "corrected", ts: Date.now(), ...e }),
    consolidated: (e) => write({ kind: "consolidated", ts: Date.now(), ...e }),
  };
}

export interface MemorySummary {
  recall?: { injected: number; stale: number; changed: number; types: Record<string, number>; foreign?: number };
  writes: number;
  writesMerged: number;
  byType: Record<string, { total: number; merged: number }>;
  distill?: { extracted: number; added: number; updated: number };
  // 合并 pass(consolidated 事件):本会话启动期跑了几轮、合并组数、取代旧条目数、各组理由。
  consolidation?: { runs: number; groups: number; superseded: number; reasons: string[] };
}

export function summarizeMemoryTrace(events: MemoryTraceEvent[]): MemorySummary {
  const s: MemorySummary = { writes: 0, writesMerged: 0, byType: {} };
  for (const e of events) {
    if (e.kind === "recalled") s.recall = { injected: e.injected, stale: e.stale, changed: e.changed, types: e.types, ...(e.foreign ? { foreign: e.foreign } : {}) };
    else if (e.kind === "wrote") {
      s.writes++; if (e.merged) s.writesMerged++;
      const t = (s.byType[e.type] ??= { total: 0, merged: 0 });
      t.total++; if (e.merged) t.merged++;
    } else if (e.kind === "distilled") s.distill = { extracted: e.extracted, added: e.added, updated: e.updated };
    else if (e.kind === "consolidated") {
      const c = (s.consolidation ??= { runs: 0, groups: 0, superseded: 0, reasons: [] });
      c.runs++; c.groups += e.groups; c.superseded += e.superseded; c.reasons.push(...e.reasons);
    }
  }
  return s;
}

// 统一反思器汇总(reflected 事件,与记忆同在 memory-trace.jsonl)。
export interface ReflectSummary {
  rounds: number; // 回合数(含跳过)
  ran: number; // 实际跑了几次
  advisories: number; // 注入了几条 advisory(有问题才有)
  memAdded: number;
  memMerged: number;
  lastInterval: number; // 当前自适应间隔
  notes: string[]; // 模型每轮的复述(可观测:advisory=0 时据此判断是否真审视过)
  corrected: number; // 纠错(supersede/revise)累计
  confirmed: number; // 确认续命累计
  correctedDetails: { target: string; action: string; reason: string }[]; // 每条纠错的 reason 明细(复盘用)
}

export function summarizeReflectTrace(events: MemoryTraceEvent[]): ReflectSummary {
  const s: ReflectSummary = { rounds: 0, ran: 0, advisories: 0, memAdded: 0, memMerged: 0, lastInterval: 1, notes: [], corrected: 0, confirmed: 0, correctedDetails: [] };
  for (const e of events) {
    if (e.kind === "corrected") { s.correctedDetails.push({ target: e.target, action: e.action, reason: e.reason }); continue; }
    if (e.kind !== "reflected") continue;
    s.rounds++;
    if (e.ran) s.ran++;
    if (e.advisoryInjected) s.advisories++;
    s.memAdded += e.memAdded;
    s.memMerged += e.memMerged;
    s.lastInterval = e.interval;
    if (e.note) s.notes.push(e.note);
    s.corrected += e.corrected ?? 0;
    s.confirmed += e.confirmed ?? 0;
  }
  return s;
}

export function formatReflectReport(s: ReflectSummary): string {
  const lines = [
    "统一反思器:",
    `  回合:${s.rounds}(实跑 ${s.ran} · 节奏跳过 ${s.rounds - s.ran})`,
    `  advisory:${s.advisories} 次(有问题才注入)`,
    `  记忆:新增 ${s.memAdded} · 合并 ${s.memMerged}`,
    `  纠错:supersede/revise ${s.corrected} · 确认续命 ${s.confirmed}`,
    `  当前节奏:每 ${s.lastInterval} 回合反思一次`,
  ];
  // 纠错明细(reason):防刷屏只列最近 3 条,用来复盘"错纠污染全局"的最大风险。
  if (s.correctedDetails.length) {
    lines.push(`  纠错明细(最近 ${Math.min(3, s.correctedDetails.length)}/${s.correctedDetails.length} 条):`);
    for (const d of s.correctedDetails.slice(-3)) lines.push(`    · ${d.action} 「${d.target}」:${d.reason}`);
  }
  // 复述抽样(尤其 advisory=0 时,用来判断"零挑战"是真在轨还是橡皮章)。只列最近几条防刷屏。
  if (s.notes.length) {
    lines.push(`  复述(最近 ${Math.min(3, s.notes.length)}/${s.notes.length} 条):`);
    for (const n of s.notes.slice(-3)) lines.push(`    · ${n}`);
  }
  return lines.join("\n");
}

export function readAllMemoryTraces(sessionsRoot: string): MemoryTraceEvent[] {
  const events: MemoryTraceEvent[] = [];
  let dirs: string[];
  try { dirs = readdirSync(sessionsRoot); } catch { return events; }
  for (const d of dirs) {
    let raw: string;
    try { raw = readFileSync(path.join(sessionsRoot, d, "memory-trace.jsonl"), "utf8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line) as MemoryTraceEvent); } catch { /* 坏行跳过 */ }
    }
  }
  return events;
}

export function formatMemoryReport(s: MemorySummary): string {
  const lines: string[] = ["记忆审计:"];
  if (s.recall) lines.push(`  召回:注入 ${s.recall.injected} · 剔除 stale ${s.recall.stale} · 标记 changed ${s.recall.changed}${s.recall.foreign ? ` · 挡掉跨项目 knowledge ${s.recall.foreign}` : ""}`);
  const mergeRate = s.writes ? ((s.writesMerged / s.writes) * 100).toFixed(0) : "0";
  lines.push(`  写入:${s.writes} 次(合并 ${s.writesMerged},合并率 ${mergeRate}%)`);
  for (const [t, v] of Object.entries(s.byType)) lines.push(`    ${t}: ${v.total} 写 / ${v.merged} 合并`);
  if (s.distill) lines.push(`  蒸馏:抽取 ${s.distill.extracted} · 新建 ${s.distill.added} · 合并 ${s.distill.updated}`);
  if (s.consolidation) {
    const c = s.consolidation;
    lines.push(`  合并 pass:${c.runs} 轮 · 合并组 ${c.groups} · 取代旧条目 ${c.superseded}`);
    for (const r of c.reasons.slice(0, 3)) lines.push(`    · ${r}`);
  }
  return lines.join("\n");
}
