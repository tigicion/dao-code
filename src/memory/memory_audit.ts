import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { auditEnabled } from "../session/audit_switch.js";

// 记忆审计:召回(会话启动注入了什么)/写入(memory_write 新建 vs 合并)/蒸馏(退出抽取)。
// 落盘 <sessionDir>/memory-trace.jsonl。受总开关 DAO_AUDIT(默认开)/DAO_MEMORY_AUDIT 控制。
export type MemoryTraceEvent =
  | { kind: "recalled"; ts: number; injected: number; stale: number; changed: number; types: Record<string, number> }
  | { kind: "wrote"; ts: number; type: string; merged: boolean }
  | { kind: "distilled"; ts: number; extracted: number; added: number; updated: number };

export interface MemoryAuditSink {
  recalled(injected: number, stale: number, changed: number, types: Record<string, number>): void;
  wrote(type: string, merged: boolean): void;
  distilled(extracted: number, added: number, updated: number): void;
}

const NOOP: MemoryAuditSink = { recalled() {}, wrote() {}, distilled() {} };

export function createMemoryAuditSink(sessionDir: string, env: NodeJS.ProcessEnv = process.env): MemoryAuditSink {
  if (!auditEnabled(env, "MEMORY")) return NOOP;
  const file = path.join(sessionDir, "memory-trace.jsonl");
  try { mkdirSync(sessionDir, { recursive: true }); } catch { /* 落盘时再兜底 */ }
  const write = (ev: MemoryTraceEvent) => {
    try { appendFileSync(file, JSON.stringify(ev) + "\n"); } catch { /* 观测落盘失败不影响主流程 */ }
  };
  return {
    recalled: (injected, stale, changed, types) => write({ kind: "recalled", ts: Date.now(), injected, stale, changed, types }),
    wrote: (type, merged) => write({ kind: "wrote", ts: Date.now(), type, merged }),
    distilled: (extracted, added, updated) => write({ kind: "distilled", ts: Date.now(), extracted, added, updated }),
  };
}

export interface MemorySummary {
  recall?: { injected: number; stale: number; changed: number; types: Record<string, number> };
  writes: number;
  writesMerged: number;
  byType: Record<string, { total: number; merged: number }>;
  distill?: { extracted: number; added: number; updated: number };
}

export function summarizeMemoryTrace(events: MemoryTraceEvent[]): MemorySummary {
  const s: MemorySummary = { writes: 0, writesMerged: 0, byType: {} };
  for (const e of events) {
    if (e.kind === "recalled") s.recall = { injected: e.injected, stale: e.stale, changed: e.changed, types: e.types };
    else if (e.kind === "wrote") {
      s.writes++; if (e.merged) s.writesMerged++;
      const t = (s.byType[e.type] ??= { total: 0, merged: 0 });
      t.total++; if (e.merged) t.merged++;
    } else if (e.kind === "distilled") s.distill = { extracted: e.extracted, added: e.added, updated: e.updated };
  }
  return s;
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
  if (s.recall) lines.push(`  召回:注入 ${s.recall.injected} · 剔除 stale ${s.recall.stale} · 标记 changed ${s.recall.changed}`);
  const mergeRate = s.writes ? ((s.writesMerged / s.writes) * 100).toFixed(0) : "0";
  lines.push(`  写入:${s.writes} 次(合并 ${s.writesMerged},合并率 ${mergeRate}%)`);
  for (const [t, v] of Object.entries(s.byType)) lines.push(`    ${t}: ${v.total} 写 / ${v.merged} 合并`);
  if (s.distill) lines.push(`  蒸馏:抽取 ${s.distill.extracted} · 新建 ${s.distill.added} · 合并 ${s.distill.updated}`);
  return lines.join("\n");
}
