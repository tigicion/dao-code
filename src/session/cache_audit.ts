import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Usage } from "../client/types.js";
import { auditEnabled } from "./audit_switch.js";

// 一次 API 调用的审计输入:调用点提供四维【原始内容】,sink 内部算哈希/变更/delta。
// tools 传入已序列化的字符串(JSON.stringify(tools));工具调用类(classifier 等)可传空串。
export interface CacheAuditInput {
  agent: "main" | "sub" | "fork" | "bg" | "classifier" | "summary" | "distill";
  subId?: string; // 子/后台 agent 短 id;main 与工具调用省略
  depth: number;  // subagentDepth;main=0
  turn: number;   // 该 agent 内回合序号(0 基)
  model: string;
  usage: Usage;
  sys: string;
  tools: string;
  tail: string;
}

export interface CacheAuditDelta { fromLen: number; toLen: number; firstDiffAt: number; sample: string }

export interface CacheAuditEvent {
  agent: string; subId?: string; depth: number; turn: number; model: string;
  prompt: number; hit: number; miss: number; completion: number; ratio: number;
  fp: { model: string; sys: string; tools: string; tail: string };
  changed: string[];
  delta?: Record<string, CacheAuditDelta>;
}

export interface CacheAuditSink { record(input: CacheAuditInput): void }

// 廉价稳定哈希(djb2):只判"是否变化",不求抗碰撞。与 loop.ts 同款。
function cheapHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// 首个分歧字节位置 + 该处约 120 字符新串样本(prefix cache 调试:前缀在哪断)。
export function divergence(a: string, b: string): { firstDiffAt: number; sample: string } {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return { firstDiffAt: i, sample: b.slice(i, i + 120) };
}

const NOOP: CacheAuditSink = { record() {} };

// 每会话一个 sink。DAO_CACHE_AUDIT=0 → 零成本 no-op。落盘:<sessionDir>/cache.jsonl。
export function createCacheAuditSink(sessionDir: string, env: NodeJS.ProcessEnv = process.env): CacheAuditSink {
  if (!auditEnabled(env, "CACHE")) return NOOP;
  const file = path.join(sessionDir, "cache.jsonl");
  try { mkdirSync(sessionDir, { recursive: true }); } catch { /* 目录已存在/不可建,落盘时再兜底 */ }
  // 按 agentKey 记上一条四维原始内容,算 changed/delta。子 agent 各自一桶,互不污染。
  const prev = new Map<string, { model: string; sys: string; tools: string; tail: string }>();
  const DIMS = ["model", "sys", "tools", "tail"] as const;
  return {
    record(inp) {
      const key = `${inp.agent}:${inp.subId ?? ""}:${inp.depth}`;
      const cur = { model: inp.model, sys: inp.sys, tools: inp.tools, tail: inp.tail };
      const p = prev.get(key);
      const changed: string[] = [];
      const delta: Record<string, CacheAuditDelta> = {};
      if (p) {
        for (const d of DIMS) {
          if (cheapHash(cur[d]) !== cheapHash(p[d])) {
            changed.push(d);
            if (d !== "model") {
              const dv = divergence(p[d], cur[d]);
              delta[d] = { fromLen: p[d].length, toLen: cur[d].length, firstDiffAt: dv.firstDiffAt, sample: dv.sample };
            }
          }
        }
      }
      prev.set(key, cur);
      const u = inp.usage;
      const prompt = u.prompt_tokens ?? 0;
      const hit = u.prompt_cache_hit_tokens ?? 0;
      const ev: CacheAuditEvent = {
        agent: inp.agent,
        ...(inp.subId ? { subId: inp.subId } : {}),
        depth: inp.depth, turn: inp.turn, model: inp.model,
        prompt, hit, miss: u.prompt_cache_miss_tokens ?? 0, completion: u.completion_tokens ?? 0,
        ratio: prompt > 0 ? hit / prompt : 0,
        fp: { model: cheapHash(inp.model), sys: cheapHash(inp.sys), tools: cheapHash(inp.tools), tail: cheapHash(inp.tail) },
        changed,
        ...(Object.keys(delta).length ? { delta } : {}),
      };
      try { appendFileSync(file, JSON.stringify({ ...ev, ts: Date.now() }) + "\n"); } catch { /* 観測落盘失败不影响主流程 */ }
    },
  };
}

// 渲染逐轮缓存命中报告(供 /audit cache)。ttlMs:空闲超此且命中骤降判 TTL 过期。
export function formatCacheReport(events: CacheAuditEvent[], ttlMs = 5 * 60 * 1000): string {
  if (events.length === 0) return "缓存审计为空。";
  const rows: string[] = [];
  let prevTs = 0;
  for (const e of events as Array<CacheAuditEvent & { ts?: number }>) {
    const who = e.agent === "main" ? "main" : `${e.agent}${e.subId ? `#${e.subId}` : ""}@${e.depth}`;
    const pct = (e.ratio * 100).toFixed(0).padStart(3);
    const changed = e.changed ?? [];
    const ts = e.ts ?? 0;
    const idle = prevTs ? ts - prevTs : 0;
    let flag = "";
    if (changed.length) flag = `⚠ 破:${changed.join("/")}`;
    else if (e.ratio < 0.3 && e.prompt >= 4000 && idle > ttlMs) flag = `· TTL过期(空闲${(idle / 60000).toFixed(1)}min)`;
    rows.push(`  t${e.turn} ${who.padEnd(12)} ${String(e.prompt).padStart(7)}tok 命中${pct}% ${flag}`);
    prevTs = ts;
  }
  return `缓存审计(记录 ${events.length}):\n` + rows.join("\n") +
    "\n(⚠破=某前缀维变化;TTL过期=四维稳但空闲超时,非bug。详查 cache.jsonl 的 delta)";
}
