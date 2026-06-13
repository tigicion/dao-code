import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { auditEnabled } from "../session/audit_switch.js";

// 权限审计:每次工具裁决记 工具/能力/模式/裁决/来源。落盘 <sessionDir>/perm-trace.jsonl。
// 受总开关 DAO_AUDIT(默认开)/DAO_PERM_AUDIT 控制。
// decision:规则直接 allow/deny;走审批后人工准/驳为 ask-approved/ask-denied。
// source:rule=规则直接定;ask=进了审批流(分类器/人工更细归因待 gate 改造)。
export type PermDecision = "allow" | "deny" | "ask-approved" | "ask-denied";
export type PermSource = "rule" | "ask";
export type PermTraceEvent = { kind: "decided"; ts: number; tool: string; cap: string; mode: string; decision: PermDecision; source: PermSource };

export interface PermAuditSink {
  decided(tool: string, cap: string, decision: PermDecision, source: PermSource): void;
}

const NOOP: PermAuditSink = { decided() {} };

export function createPermAuditSink(sessionDir: string, getMode: () => string, env: NodeJS.ProcessEnv = process.env): PermAuditSink {
  if (!auditEnabled(env, "PERM")) return NOOP;
  const file = path.join(sessionDir, "perm-trace.jsonl");
  try { mkdirSync(sessionDir, { recursive: true }); } catch { /* 落盘时再兜底 */ }
  return {
    decided: (tool, cap, decision, source) => {
      try { appendFileSync(file, JSON.stringify({ kind: "decided", ts: Date.now(), tool, cap, mode: getMode(), decision, source }) + "\n"); }
      catch { /* 观测落盘失败不影响主流程 */ }
    },
  };
}

export interface PermStat {
  tool: string; allow: number; deny: number; askApproved: number; askDenied: number; total: number; askRate: number;
}

export function summarizePermTrace(events: PermTraceEvent[]): PermStat[] {
  const m = new Map<string, { allow: number; deny: number; askApproved: number; askDenied: number }>();
  const get = (n: string) => { let a = m.get(n); if (!a) { a = { allow: 0, deny: 0, askApproved: 0, askDenied: 0 }; m.set(n, a); } return a; };
  for (const e of events) {
    if (e.kind !== "decided") continue;
    const a = get(e.tool);
    if (e.decision === "allow") a.allow++;
    else if (e.decision === "deny") a.deny++;
    else if (e.decision === "ask-approved") a.askApproved++;
    else if (e.decision === "ask-denied") a.askDenied++;
  }
  const stats: PermStat[] = [];
  for (const [tool, a] of m) {
    const total = a.allow + a.deny + a.askApproved + a.askDenied;
    const asks = a.askApproved + a.askDenied;
    stats.push({ tool, ...a, total, askRate: total ? asks / total : 0 });
  }
  return stats.sort((x, y) => y.askRate - x.askRate || y.total - x.total);
}

export function readAllPermTraces(sessionsRoot: string): PermTraceEvent[] {
  const events: PermTraceEvent[] = [];
  let dirs: string[];
  try { dirs = readdirSync(sessionsRoot); } catch { return events; }
  for (const d of dirs) {
    let raw: string;
    try { raw = readFileSync(path.join(sessionsRoot, d, "perm-trace.jsonl"), "utf8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line) as PermTraceEvent); } catch { /* 坏行跳过 */ }
    }
  }
  return events;
}

export function formatPermReport(stats: PermStat[]): string {
  if (stats.length === 0) return "暂无权限裁决记录。";
  const rows = stats.map((s) =>
    `  ${s.tool.padEnd(18)} 询问率 ${(s.askRate * 100).toFixed(0).padStart(3)}% · allow ${s.allow} · deny ${s.deny} · 问准 ${s.askApproved} · 问驳 ${s.askDenied}`);
  return ["权限裁决审计(询问率高在前 → 可加 allow 白名单):", ...rows].join("\n");
}
