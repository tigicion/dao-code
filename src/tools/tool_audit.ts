import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { auditEnabled } from "../session/audit_switch.js";

// 工具审计:每次工具执行记 名/能力/成败/耗时/参数摘要。落盘 <sessionDir>/tool-trace.jsonl。
// 受总开关 DAO_AUDIT(默认开)/DAO_TOOL_AUDIT 控制。
export type ToolTraceEvent = { kind: "call"; ts: number; name: string; cap: string; ok: boolean; durationMs: number; args: string };

export interface ToolAuditSink {
  call(name: string, cap: string, ok: boolean, durationMs: number, args: string): void;
}

const NOOP: ToolAuditSink = { call() {} };

export function createToolAuditSink(sessionDir: string, env: NodeJS.ProcessEnv = process.env): ToolAuditSink {
  if (!auditEnabled(env, "TOOL")) return NOOP;
  const file = path.join(sessionDir, "tool-trace.jsonl");
  try { mkdirSync(sessionDir, { recursive: true }); } catch { /* 落盘时再兜底 */ }
  return {
    call: (name, cap, ok, durationMs, args) => {
      try { appendFileSync(file, JSON.stringify({ kind: "call", ts: Date.now(), name, cap, ok, durationMs, args: args.slice(0, 120) }) + "\n"); }
      catch { /* 观测落盘失败不影响主流程 */ }
    },
  };
}

export interface ToolStat {
  name: string; calls: number; errors: number; errorRate: number; avgMs: number; maxMs: number; totalMs: number;
}

export function summarizeToolTrace(events: ToolTraceEvent[]): ToolStat[] {
  const m = new Map<string, { calls: number; errors: number; totalMs: number; maxMs: number }>();
  const get = (n: string) => { let a = m.get(n); if (!a) { a = { calls: 0, errors: 0, totalMs: 0, maxMs: 0 }; m.set(n, a); } return a; };
  for (const e of events) {
    if (e.kind !== "call") continue;
    const a = get(e.name);
    a.calls++; if (!e.ok) a.errors++; a.totalMs += e.durationMs; a.maxMs = Math.max(a.maxMs, e.durationMs);
  }
  const stats: ToolStat[] = [];
  for (const [name, a] of m) stats.push({
    name, calls: a.calls, errors: a.errors, errorRate: a.calls ? a.errors / a.calls : 0,
    avgMs: a.calls ? a.totalMs / a.calls : 0, maxMs: a.maxMs, totalMs: a.totalMs,
  });
  return stats.sort((x, y) => y.errorRate - x.errorRate || y.calls - x.calls);
}

export function readAllToolTraces(sessionsRoot: string): ToolTraceEvent[] {
  const events: ToolTraceEvent[] = [];
  let dirs: string[];
  try { dirs = readdirSync(sessionsRoot); } catch { return events; }
  for (const d of dirs) {
    let raw: string;
    try { raw = readFileSync(path.join(sessionsRoot, d, "tool-trace.jsonl"), "utf8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line) as ToolTraceEvent); } catch { /* 坏行跳过 */ }
    }
  }
  return events;
}

export function formatToolReport(stats: ToolStat[]): string {
  if (stats.length === 0) return "暂无工具调用记录。";
  const rows = stats.map((s) =>
    `  ${s.name.padEnd(18)} 调用 ${String(s.calls).padStart(4)} · 错误率 ${(s.errorRate * 100).toFixed(0).padStart(3)}% · 均 ${s.avgMs.toFixed(0)}ms · 峰 ${s.maxMs}ms`);
  return ["工具调用审计(错误率高在前):", ...rows].join("\n");
}
