# 子系统审计(记忆/工具/权限)+ 总开关 + 统一 /audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给记忆/工具/权限三子系统各加一条按会话落盘的审计 trace,统一受总开关 `DAO_AUDIT`(默认开)控制,并把五条审计流收口到一个 `/audit <子系统> [id]` 命令下(删 `/cache`、`/skills audit`)。

**Architecture:** 每子系统一个自包含审计模块(领域专用 sink + summarize + readAll + format),照 `src/skills/skill_audit.ts` 模板;sink 经 `ToolContext` 或 index.ts 直接注入,会话 store 就绪后赋值(无 store 路径自然 NOOP);共享 `auditEnabled(env,key)` 收口开关。skill「该加载没加载」由外部 cc 裁判,dao 只补会话级技能目录快照。

**Tech Stack:** TypeScript(ESM,`.js` import 后缀)、Node `fs`、Vitest。单文件:`npx vitest run <file>`;全量:`npm test`;类型:`npm run typecheck`;lint:`npm run lint`(须 0 error)。

参见 spec:`docs/superpowers/specs/2026-06-16-subsystem-audit-design.md`

---

## File Structure

| 文件 | 职责 | 改动 |
|---|---|---|
| `src/session/audit_switch.ts` | `auditEnabled(env,key)` 共享开关 | 新建 |
| `src/memory/memory_audit.ts` | 记忆审计:recalled/wrote/distilled | 新建 |
| `src/tools/tool_audit.ts` | 工具审计:每次调用计时/成败 | 新建 |
| `src/permissions/perm_audit.ts` | 权限审计:每次裁决 | 新建 |
| `src/session/cache_audit.ts` | 加 `formatCacheReport`;开关改 `auditEnabled` | 修改 |
| `src/skills/skill_audit.ts` | 开关改 `auditEnabled` | 修改 |
| `src/tools/types.ts` | `ToolContext` 加 3 个 audit sink 字段 | 修改 |
| `src/tools/execute.ts` | `dispatchOne` 记 call;裁决循环记 decided | 修改 |
| `src/tools/memory_write.ts` | 写入记 wrote | 修改 |
| `src/index.ts` | 建 sink+注入;recall/distill 记录;catalog 快照;`/audit`;删 `/cache`、`/skills audit` | 修改 |
| `src/tui/app/App.tsx` | `SLASH_COMMANDS` 去 cache 加 audit | 修改 |

各 `*_audit.ts` 配同名 `.test.ts`。Task 1–6 独立可并行;Task 7–11 依赖前面模块。

---

## Task 1: 共享开关 `auditEnabled`

**Files:** Create `src/session/audit_switch.ts` + `src/session/audit_switch.test.ts`

- [ ] **Step 1: 写失败测试** — `src/session/audit_switch.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { auditEnabled } from "./audit_switch.js";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("auditEnabled", () => {
  it("默认开:DAO_AUDIT 未设 → true", () => {
    expect(auditEnabled(env({}), "MEMORY")).toBe(true);
  });
  it("DAO_AUDIT=0 → 全关", () => {
    expect(auditEnabled(env({ DAO_AUDIT: "0" }), "TOOL")).toBe(false);
  });
  it("DAO_<X>_AUDIT 覆盖优先", () => {
    expect(auditEnabled(env({ DAO_AUDIT: "0", DAO_TOOL_AUDIT: "1" }), "TOOL")).toBe(true);
    expect(auditEnabled(env({ DAO_AUDIT: "1", DAO_CACHE_AUDIT: "0" }), "CACHE")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑确认失败** — `npx vitest run src/session/audit_switch.test.ts` → FAIL（模块未建）。

- [ ] **Step 3: 实现** — `src/session/audit_switch.ts`:

```ts
// 审计总开关判定。默认开:DAO_AUDIT 未设即启用;DAO_AUDIT=0 一键全关。
// 每流细粒度覆盖优先:DAO_<KEY>_AUDIT=0/1。收口一处,默认值后续可一行改。
export type AuditKey = "MEMORY" | "TOOL" | "PERM" | "CACHE" | "SKILL";

export function auditEnabled(env: NodeJS.ProcessEnv, key: AuditKey): boolean {
  const specific = env[`DAO_${key}_AUDIT`];
  if (specific === "0") return false;
  if (specific === "1") return true;
  return env.DAO_AUDIT !== "0"; // 默认开
}
```

- [ ] **Step 4: 跑确认通过** — `npx vitest run src/session/audit_switch.test.ts` → PASS。

- [ ] **Step 5: typecheck + 提交**

```bash
npm run typecheck
git add src/session/audit_switch.ts src/session/audit_switch.test.ts
git commit -m "feat(audit): 共享总开关 auditEnabled(env,key)——默认开,DAO_AUDIT=0 全关"
```

---

## Task 2: 记忆审计模块 `memory_audit.ts`

**Files:** Create `src/memory/memory_audit.ts` + `.test.ts`

- [ ] **Step 1: 写失败测试** — `src/memory/memory_audit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMemoryAuditSink, summarizeMemoryTrace, formatMemoryReport, type MemoryTraceEvent } from "./memory_audit.js";

const read = (dir: string) =>
  readFileSync(path.join(dir, "memory-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as MemoryTraceEvent);

describe("memory_audit sink", () => {
  it("recalled/wrote/distilled 各落一行", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mem-a-"));
    const s = createMemoryAuditSink(dir, {} as NodeJS.ProcessEnv);
    s.recalled(10, 2, 1, { user: 4, semantic: 6 });
    s.wrote("user", false);
    s.wrote("semantic", true);
    s.distilled(5, 3, 2);
    const ev = read(dir);
    expect(ev).toHaveLength(4);
    expect(ev[0]).toMatchObject({ kind: "recalled", injected: 10, stale: 2, changed: 1 });
    expect(ev[3]).toMatchObject({ kind: "distilled", extracted: 5, added: 3, updated: 2 });
  });

  it("DAO_MEMORY_AUDIT=0 → no-op", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mem-a-"));
    const s = createMemoryAuditSink(dir, { DAO_MEMORY_AUDIT: "0" } as unknown as NodeJS.ProcessEnv);
    s.wrote("user", false);
    expect(existsSync(path.join(dir, "memory-trace.jsonl"))).toBe(false);
  });

  it("summarize 算合并率 + 召回 + 蒸馏", () => {
    const ev: MemoryTraceEvent[] = [
      { kind: "recalled", ts: 0, injected: 10, stale: 2, changed: 1, types: { user: 4 } },
      { kind: "wrote", ts: 0, type: "user", merged: false },
      { kind: "wrote", ts: 0, type: "user", merged: true },
      { kind: "distilled", ts: 0, extracted: 5, added: 3, updated: 2 },
    ];
    const sum = summarizeMemoryTrace(ev);
    expect(sum.recall).toMatchObject({ injected: 10, stale: 2 });
    expect(sum.writes).toBe(2);
    expect(sum.writesMerged).toBe(1);
    expect(sum.byType.user).toMatchObject({ total: 2, merged: 1 });
    expect(sum.distill).toMatchObject({ extracted: 5, added: 3, updated: 2 });
    expect(formatMemoryReport(sum)).toContain("合并");
  });
});
```

- [ ] **Step 2: 跑确认失败** — `npx vitest run src/memory/memory_audit.test.ts` → FAIL。

- [ ] **Step 3: 实现** — `src/memory/memory_audit.ts`:

```ts
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
```

- [ ] **Step 4: 跑确认通过 + 提交**

```bash
npx vitest run src/memory/memory_audit.test.ts
npm run typecheck
git add src/memory/memory_audit.ts src/memory/memory_audit.test.ts
git commit -m "feat(audit): 记忆审计模块——召回/写入合并率/蒸馏产出"
```

---

## Task 3: 工具审计模块 `tool_audit.ts`

**Files:** Create `src/tools/tool_audit.ts` + `.test.ts`

- [ ] **Step 1: 写失败测试** — `src/tools/tool_audit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createToolAuditSink, summarizeToolTrace, formatToolReport, type ToolTraceEvent } from "./tool_audit.js";

const read = (dir: string) =>
  readFileSync(path.join(dir, "tool-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as ToolTraceEvent);

describe("tool_audit sink", () => {
  it("call 落一行,args 截断 120", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tool-a-"));
    const s = createToolAuditSink(dir, {} as NodeJS.ProcessEnv);
    s.call("read_file", "read", true, 12, "x".repeat(300));
    const ev = read(dir);
    expect(ev[0]).toMatchObject({ kind: "call", name: "read_file", cap: "read", ok: true, durationMs: 12 });
    expect((ev[0] as { args: string }).args.length).toBeLessThanOrEqual(120);
  });

  it("DAO_TOOL_AUDIT=0 → no-op", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tool-a-"));
    const s = createToolAuditSink(dir, { DAO_TOOL_AUDIT: "0" } as unknown as NodeJS.ProcessEnv);
    s.call("x", "read", true, 1, "");
    expect(existsSync(path.join(dir, "tool-trace.jsonl"))).toBe(false);
  });

  it("summarize 错误率/耗时,错误率高在前", () => {
    const ev: ToolTraceEvent[] = [
      { kind: "call", ts: 0, name: "A", cap: "read", ok: true, durationMs: 10, args: "" },
      { kind: "call", ts: 0, name: "A", cap: "read", ok: false, durationMs: 30, args: "" },
      { kind: "call", ts: 0, name: "B", cap: "read", ok: true, durationMs: 5, args: "" },
    ];
    const stats = summarizeToolTrace(ev);
    const A = stats.find((s) => s.name === "A")!;
    expect(A).toMatchObject({ calls: 2, errors: 1, maxMs: 30 });
    expect(A.errorRate).toBeCloseTo(0.5);
    expect(A.avgMs).toBeCloseTo(20);
    expect(stats[0]!.name).toBe("A");
    expect(formatToolReport(stats)).toContain("错误率");
  });
});
```

- [ ] **Step 2: 跑确认失败** — `npx vitest run src/tools/tool_audit.test.ts` → FAIL。

- [ ] **Step 3: 实现** — `src/tools/tool_audit.ts`:

```ts
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
```

- [ ] **Step 4: 跑确认通过 + 提交**

```bash
npx vitest run src/tools/tool_audit.test.ts
npm run typecheck
git add src/tools/tool_audit.ts src/tools/tool_audit.test.ts
git commit -m "feat(audit): 工具审计模块——每次调用计时/成败,汇总错误率/耗时"
```

---

## Task 4: 权限审计模块 `perm_audit.ts`

**Files:** Create `src/permissions/perm_audit.ts` + `.test.ts`

> 注:`source` v1 取 `"rule"|"ask"`(execute.ts 可干净区分"规则直接定" vs "走审批")。分类器/人工更细归因需改 gate,留后续。`mode` 由 sink 闭包 `getMode()` 盖戳。

- [ ] **Step 1: 写失败测试** — `src/permissions/perm_audit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPermAuditSink, summarizePermTrace, formatPermReport, type PermTraceEvent } from "./perm_audit.js";

const read = (dir: string) =>
  readFileSync(path.join(dir, "perm-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as PermTraceEvent);

describe("perm_audit sink", () => {
  it("decided 落一行,mode 由闭包盖戳", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "perm-a-"));
    const s = createPermAuditSink(dir, () => "auto", {} as NodeJS.ProcessEnv);
    s.decided("write_file", "write", "ask-approved", "ask");
    expect(read(dir)[0]).toMatchObject({ tool: "write_file", cap: "write", mode: "auto", decision: "ask-approved", source: "ask" });
  });

  it("DAO_PERM_AUDIT=0 → no-op", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "perm-a-"));
    const s = createPermAuditSink(dir, () => "default", { DAO_PERM_AUDIT: "0" } as unknown as NodeJS.ProcessEnv);
    s.decided("x", "read", "allow", "rule");
    expect(existsSync(path.join(dir, "perm-trace.jsonl"))).toBe(false);
  });

  it("summarize 询问率,询问率高在前", () => {
    const ev: PermTraceEvent[] = [
      { kind: "decided", ts: 0, tool: "write_file", cap: "write", mode: "default", decision: "ask-approved", source: "ask" },
      { kind: "decided", ts: 0, tool: "write_file", cap: "write", mode: "default", decision: "ask-denied", source: "ask" },
      { kind: "decided", ts: 0, tool: "read_file", cap: "read", mode: "default", decision: "allow", source: "rule" },
    ];
    const stats = summarizePermTrace(ev);
    const w = stats.find((s) => s.tool === "write_file")!;
    expect(w).toMatchObject({ askApproved: 1, askDenied: 1 });
    expect(w.askRate).toBeCloseTo(1);
    expect(stats[0]!.tool).toBe("write_file");
    expect(formatPermReport(stats)).toContain("询问率");
  });
});
```

- [ ] **Step 2: 跑确认失败** — `npx vitest run src/permissions/perm_audit.test.ts` → FAIL。

- [ ] **Step 3: 实现** — `src/permissions/perm_audit.ts`:

```ts
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
```

- [ ] **Step 4: 跑确认通过 + 提交**

```bash
npx vitest run src/permissions/perm_audit.test.ts
npm run typecheck
git add src/permissions/perm_audit.ts src/permissions/perm_audit.test.ts
git commit -m "feat(audit): 权限审计模块——每次裁决,汇总询问率/拒绝"
```

---

## Task 5: cache_audit 抽 `formatCacheReport` + 开关改 `auditEnabled`

**Files:** Modify `src/session/cache_audit.ts` + `.test.ts`

- [ ] **Step 1: 写失败测试**(追加到 `src/session/cache_audit.test.ts`,import 区补 `formatCacheReport`):

```ts
import { formatCacheReport } from "./cache_audit.js";

describe("formatCacheReport", () => {
  it("逐轮命中率 + 破缓存维度", () => {
    const evs = [
      { ts: 1000, agent: "main", depth: 0, turn: 0, model: "pro", prompt: 20000, hit: 19000, miss: 1000, completion: 5, ratio: 0.95, fp: {}, changed: [] },
      { ts: 2000, agent: "main", depth: 0, turn: 1, model: "pro", prompt: 21000, hit: 1000, miss: 20000, completion: 5, ratio: 0.05, fp: {}, changed: ["sys"] },
    ] as unknown as import("./cache_audit.js").CacheAuditEvent[];
    const out = formatCacheReport(evs);
    expect(out).toContain("t0");
    expect(out).toContain("破:sys");
  });
});
```

- [ ] **Step 2: 跑确认失败** — `npx vitest run src/session/cache_audit.test.ts` → FAIL（未导出）。

- [ ] **Step 3: 实现** — `src/session/cache_audit.ts`:

顶部 import 加:`import { auditEnabled } from "./audit_switch.js";`

把 `createCacheAuditSink` 里 `if (env.DAO_CACHE_AUDIT === "0") return NOOP;` 改为 `if (!auditEnabled(env, "CACHE")) return NOOP;`

文件末尾导出(搬 index.ts `/cache` 块的渲染为纯函数):

```ts
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
```

- [ ] **Step 4: 跑确认通过 + 提交**

```bash
npx vitest run src/session/cache_audit.test.ts
npm run typecheck
git add src/session/cache_audit.ts src/session/cache_audit.test.ts
git commit -m "refactor(audit): cache 抽 formatCacheReport 纯函数 + 开关改 auditEnabled"
```

---

## Task 6: skill_audit 开关改 `auditEnabled`

**Files:** Modify `src/skills/skill_audit.ts`

- [ ] **Step 1: 改开关** — 顶部 import 加 `import { auditEnabled } from "../session/audit_switch.js";`;把 `if (env.DAO_SKILL_AUDIT === "0") return NOOP;` 改为 `if (!auditEnabled(env, "SKILL")) return NOOP;`。

- [ ] **Step 2: 验证既有测试** — `npx vitest run src/skills/skill_audit.test.ts` → PASS（`DAO_SKILL_AUDIT=0` 显式 → `auditEnabled` 返 false,行为不变）。

- [ ] **Step 3: typecheck + 提交**

```bash
npm run typecheck
git add src/skills/skill_audit.ts
git commit -m "refactor(audit): skill 审计开关改用 auditEnabled(纳入总开关)"
```

---

## Task 7: ToolContext 字段 + execute.ts 接线

**Files:** Modify `src/tools/types.ts`, `src/tools/execute.ts`

- [ ] **Step 1: ToolContext 加字段** — 在 `src/tools/types.ts` 的 `ToolContext` 接口里(挨着其它可选字段)加:

```ts
  // 审计 sink(index 注入;无 store 路径为 NOOP)。
  toolAudit?: import("./tool_audit.js").ToolAuditSink;
  permAudit?: import("../permissions/perm_audit.js").PermAuditSink;
  memoryAudit?: import("../memory/memory_audit.js").MemoryAuditSink;
```

- [ ] **Step 2: dispatchOne 记 call** — 在 `src/tools/execute.ts` 的 `dispatchOne`(约 33 行起)。把开头:

```ts
  const name = tc.function.name;
  const argsJson = tc.function.arguments;
  try {
    if (ctx.preToolHook) {
      const h = await ctx.preToolHook(name, argsJson);
      if (h.block) return { role: "tool", tool_call_id: tc.id, content: `[被 hook 阻止] ${h.reason || "(无原因)"}` };
    }
    const content = await registry.dispatch(name, argsJson, ctx);
    if (ctx.postToolHook) await ctx.postToolHook(name, argsJson, content);
```

改为(加计时 + `audit()` 助手,每条出口记一次):

```ts
  const name = tc.function.name;
  const argsJson = tc.function.arguments;
  const cap = registry.get(name)?.capability ?? "unknown";
  const startMs = Date.now();
  const audit = (content: string) => {
    const ok = !content.startsWith("Error") && !content.includes("被 hook 阻止");
    ctx.toolAudit?.call(name, cap, ok, Date.now() - startMs, argsJson);
  };
  try {
    if (ctx.preToolHook) {
      const h = await ctx.preToolHook(name, argsJson);
      if (h.block) { const c = `[被 hook 阻止] ${h.reason || "(无原因)"}`; audit(c); return { role: "tool", tool_call_id: tc.id, content: c }; }
    }
    const content = await registry.dispatch(name, argsJson, ctx);
    if (ctx.postToolHook) await ctx.postToolHook(name, argsJson, content);
    audit(content);
```

> 阅读 dispatchOne 完整 try/catch:若其 `catch` 分支 `return { ...content: \`Error...\` }`,在该 return 前加 `audit(errContent)`,保证每条出口记一次且只一次。

- [ ] **Step 3: 裁决/审批循环记 decided** — 在 `executeToolCalls` 第 1 步裁决循环把:

```ts
    const decision = tool ? gate.decide(tc.function.name, tc.function.arguments, tool) : "allow";
    if (decision === "allow") toRun.add(tc.id);
    else if (decision === "deny") results.set(tc.id, rejectMsg(tc, "该操作被权限规则拒绝(deny)。如需放行,请在 .dao/settings.json 调整 permissions。"));
    else {
```

改为:

```ts
    const decision = tool ? gate.decide(tc.function.name, tc.function.arguments, tool) : "allow";
    const cap0 = tool?.capability ?? "unknown";
    if (decision === "allow") { toRun.add(tc.id); ctx.permAudit?.decided(tc.function.name, cap0, "allow", "rule"); }
    else if (decision === "deny") { results.set(tc.id, rejectMsg(tc, "该操作被权限规则拒绝(deny)。如需放行,请在 .dao/settings.json 调整 permissions。")); ctx.permAudit?.decided(tc.function.name, cap0, "deny", "rule"); }
    else {
```

第 2 步审批循环把:

```ts
  for (const r of gatedRequests) {
    const tc = toolCalls.find((t) => t.id === r.id)!;
    if (approvals.get(tc.id)) toRun.add(tc.id);
    else results.set(tc.id, rejectMsg(tc, "用户拒绝执行该工具。"));
  }
```

改为:

```ts
  for (const r of gatedRequests) {
    const tc = toolCalls.find((t) => t.id === r.id)!;
    const capA = registry.get(tc.function.name)?.capability ?? "unknown";
    if (approvals.get(tc.id)) { toRun.add(tc.id); ctx.permAudit?.decided(tc.function.name, capA, "ask-approved", "ask"); }
    else { results.set(tc.id, rejectMsg(tc, "用户拒绝执行该工具。")); ctx.permAudit?.decided(tc.function.name, capA, "ask-denied", "ask"); }
  }
```

- [ ] **Step 4: typecheck + 全量测试** — `npm run typecheck` · `npm test`(审计走可选 ctx 字段,默认 undefined 即不记,既有测试不受影响)→ 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/tools/types.ts src/tools/execute.ts
git commit -m "feat(audit): execute 接线——dispatchOne 记工具调用,裁决循环记权限决策"
```

---

## Task 8: memory_write 接线(记 wrote)

**Files:** Modify `src/tools/memory_write.ts`

- [ ] **Step 1: 写入后记审计** — 在 handler 里 `upsertMemory` 结果 `r` 拿到后、`const label = ...` 前插入:

```ts
    ctx.memoryAudit?.wrote(cand.type, r.action === "updated"); // 审计:新建 vs 合并近重复
```

> `cand.type` = 写入记忆类型;`r.action` ∈ `"added"|"updated"`,`"updated"` 即合并。

- [ ] **Step 2: typecheck + 测试** — `npm run typecheck` · `npx vitest run src/tools/memory_write.test.ts`(若存在;审计走可选 ctx,既有测试不受影响)→ 绿。

- [ ] **Step 3: 提交**

```bash
git add src/tools/memory_write.ts
git commit -m "feat(audit): memory_write 记写入(新建 vs 合并)"
```

---

## Task 9: index.ts 建 sink + 注入 + recall/distill 记录 + catalog 快照

**Files:** Modify `src/index.ts`

- [ ] **Step 1: import** — 顶部 import 区(挨着 `createCacheAuditSink`)加:

```ts
import { auditEnabled } from "./session/audit_switch.js";
import { createMemoryAuditSink, type MemoryAuditSink } from "./memory/memory_audit.js";
import { createToolAuditSink, type ToolAuditSink } from "./tools/tool_audit.js";
import { createPermAuditSink, type PermAuditSink } from "./permissions/perm_audit.js";
```

- [ ] **Step 2: 外层占位 sink** — 在 `let cacheSink: CacheAuditSink = { record() {} };` 之后加:

```ts
  let memoryAudit: MemoryAuditSink = { recalled() {}, wrote() {}, distilled() {} };
  let toolAudit: ToolAuditSink = { call() {} };
  let permAudit: PermAuditSink = { decided() {} };
```

- [ ] **Step 3: 召回计数** — `src/index.ts` 的 `const memoryText = buildMemorySection(selectForInjection(validated, today));` 改为:

```ts
  const injectedMems = selectForInjection(validated, today);
  const memoryText = buildMemorySection(injectedMems);
  const recallStale = validated.filter((v) => v.verdict === "stale").length;
  const recallChanged = validated.filter((v) => v.verdict === "changed").length;
  const recallTypes: Record<string, number> = {};
  for (const it of injectedMems) recallTypes[it.mem.type] = (recallTypes[it.mem.type] ?? 0) + 1;
```

- [ ] **Step 4: store 后建真 sink + 注入 + 补记召回 + catalog 快照** — 在 `cacheSink = createCacheAuditSink(store.dir);` 之后加:

```ts
      memoryAudit = createMemoryAuditSink(store.dir);
      toolAudit = createToolAuditSink(store.dir);
      permAudit = createPermAuditSink(store.dir, getMode);
      ctx.toolAudit = toolAudit; ctx.permAudit = permAudit; ctx.memoryAudit = memoryAudit;
      memoryAudit.recalled(injectedMems.length, recallStale, recallChanged, recallTypes);
      try {
        if (auditEnabled(process.env, "SKILL")) {
          writeFileSync(path.join(store.dir, "skills-catalog.json"),
            JSON.stringify(skills.map((s) => ({ name: s.name, description: s.description, whenToUse: s.whenToUse ?? "" }))));
        }
      } catch { /* 快照失败不影响 */ }
```

> `getMode`、`skills`、`writeFileSync`、`path` 均已在 index.ts 作用域。`ctx` 是对象,闭包持引用,赋值在 store 后、任何回合执行前。

- [ ] **Step 5: 蒸馏记录** — `distillOnExit` 的 upsert 循环改为统计 added/updated 并记审计:

```ts
      let n = 0, added = 0, updated = 0;
      for (const cand of cands) {
        const existing = await loadAllMemories(projectMemoryDir, userMemoryDir, knowledgeMemoryDir);
        const scope = routeScope(cand.type, cand.confidence);
        const dir = scope === "knowledge" ? knowledgeMemoryDir : scope === "user" ? userMemoryDir : projectMemoryDir;
        const res = await upsertMemory(dir, cand, existing, adjudicate);
        if (res.action === "updated") updated++; else added++;
        n++;
      }
      memoryAudit.distilled(cands.length, added, updated);
      write(n > 0 ? `✓ 已更新记忆:${n} 条\n` : `✓ 记忆无需更新\n`);
```

- [ ] **Step 6: typecheck + 全量 + lint** — `npm run typecheck` · `npm test` · `npm run lint`(0 error)→ 全绿。

- [ ] **Step 7: 提交**

```bash
git add src/index.ts
git commit -m "feat(audit): index 建三 sink + 注入 ctx;记召回/蒸馏;落技能目录快照"
```

---

## Task 10: 统一 `/audit` 命令 + 删 `/cache`、`/skills audit` + SLASH_COMMANDS

**Files:** Modify `src/index.ts`, `src/commands/commands.ts`, `src/tui/app/App.tsx`

- [ ] **Step 1: import** — 顶部加:

```ts
import { readAllMemoryTraces, summarizeMemoryTrace, formatMemoryReport } from "./memory/memory_audit.js";
import { readAllToolTraces, summarizeToolTrace, formatToolReport } from "./tools/tool_audit.js";
import { readAllPermTraces, summarizePermTrace, formatPermReport } from "./permissions/perm_audit.js";
import { formatCacheReport } from "./session/cache_audit.js";
```

> `readAllSkillTraces`/`summarizeSkillTrace`/`formatSkillReport` 已 import。`readAllMemoryTraces`/`readAllToolTraces`/`readAllPermTraces` 本命令未直接用(按会话读 dir),但导入保持模块 API 完整、避免 lint 未用——若 lint 报未用,删掉这三个未用名即可。

- [ ] **Step 2: 删 `/cache` 块** — 删除 `if (name === "cache") { ... }` 整块(以 `缓存审计 · 会话 ...` 收尾)。

- [ ] **Step 3: 删 `/skills audit` 子分支** — 在 `if (name === "skills") { ... }` 内删除 `if (sub === "audit") { ... }` 段;`/skills` 列出/开关保留。

- [ ] **Step 4: 加 `/audit` 命令**(在 `/permissions` 块之后插入):

```ts
          if (name === "audit") {
            const parts = line.trim().split(/\s+/);
            const sub = parts[1];
            const id = parts[2];
            const dir = id ? path.join(sessionsDir, id) : store.dir;
            const valid = ["memory", "tools", "perms", "cache", "skills", "all"];
            if (!sub || !valid.includes(sub)) return { handled: true, output: `用法:/audit <memory|tools|perms|cache|skills|all> [会话id]\n默认审当前会话(${store.id})。` };
            const readJsonl = (file: string): Record<string, unknown>[] => {
              try {
                return readFileSync(path.join(dir, file), "utf8").trim().split("\n").filter(Boolean)
                  .flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
              } catch { return []; }
            };
            const sections: string[] = [];
            const want = (k: string) => sub === "all" || sub === k;
            if (want("memory")) sections.push(formatMemoryReport(summarizeMemoryTrace(readJsonl("memory-trace.jsonl") as never)));
            if (want("tools")) sections.push(formatToolReport(summarizeToolTrace(readJsonl("tool-trace.jsonl") as never)));
            if (want("perms")) sections.push(formatPermReport(summarizePermTrace(readJsonl("perm-trace.jsonl") as never)));
            if (want("cache")) sections.push(formatCacheReport(readJsonl("cache.jsonl") as never));
            if (want("skills")) sections.push(formatSkillReport(summarizeSkillTrace(readAllSkillTraces(sessionsDir))));
            const head = `审计 · 会话 ${id ?? store.id} · 目录 ${dir}\n`;
            return { handled: true, output: head + sections.join("\n\n") };
          }
```

> `skills` 沿用跨会话聚合(`readAllSkillTraces(sessionsDir)`,忽略 id);其余按会话读 `dir`。`readFileSync`/`path`/`store`/`sessionsDir` 均在作用域。

- [ ] **Step 5: 帮助清单 + SLASH_COMMANDS** — `src/commands/commands.ts` 帮助串把 `/cache 缓存审计` 改 `/audit 审计(memory/tools/perms/cache/skills)`;`src/tui/app/App.tsx` 的 `SLASH_COMMANDS` 把 `"cache"` 改 `"audit"`。

- [ ] **Step 6: typecheck + 全量 + lint** — `npm run typecheck` · `npm test` · `npm run lint`(0 error)→ 全绿。

- [ ] **Step 7: 提交**

```bash
git add src/index.ts src/commands/commands.ts src/tui/app/App.tsx
git commit -m "feat(audit): 统一 /audit <子系统> [id];删 /cache 与 /skills audit;SLASH_COMMANDS 改"
```

---

## Task 11: /audit Tab 补全端到端测试

**Files:** Modify `src/tui/app/App.test.tsx`(追加)

- [ ] **Step 1: 追加测试**:

```ts
  it("Tab 补全 /audit(唯一前缀)", async () => {
    let got = "";
    const { stdin } = render(
      <App {...makeDeps({ runCommand: (l) => { got = l; return { handled: true }; } })} />,
    );
    for (const ch of "/aud") stdin.write(ch);
    await delay();
    stdin.write("\t");
    await delay();
    stdin.write("\r");
    await delay();
    expect(got.trim()).toBe("/audit");
  });
```

- [ ] **Step 2: 跑测试** — `npx vitest run src/tui/app/App.test.tsx` → PASS。

- [ ] **Step 3: 全量回归 + 提交**

```bash
npm test
npm run typecheck
npm run lint
git add src/tui/app/App.test.tsx
git commit -m "test(audit): /audit Tab 补全端到端验证"
```

---

## Self-Review(已执行)

**Spec 覆盖:** §1.1 总开关→Task 1;§3.1 记忆→Task 2+8+9;§3.2 工具→Task 3+7;§3.3 权限→Task 4+7;§3.4 skill 纳入开关→Task 6 + catalog 快照→Task 9 Step 4;§5 统一 /audit + 删 /cache、/skills audit→Task 10;§6 formatCacheReport→Task 5;cache/skill 开关改 auditEnabled→Task 5/6;SLASH_COMMANDS + Tab→Task 10/11;测试(§7)→各模块单测 + Task 11。全部有对应任务。

**与 spec 的明示偏差(plan 内已标):** ① perm `source` 收敛为 `rule|ask`(spec 列 rule/classifier/user/default),更细归因需改 gate,留后续;② 记忆蒸馏事件用 `distilled(extracted, added, updated)`(spec 文字写 created/skipped),采用调用点实际可得的更准语义。

**占位符扫描:** 无 TBD/TODO;每步给完整代码或精确编辑。

**类型一致性:** `auditEnabled(env,key)`/`AuditKey`、各 `create*AuditSink`/`*AuditSink`/`*TraceEvent`、`createPermAuditSink(dir, getMode, env)` 含 getMode、`formatCacheReport`、`ctx.toolAudit/permAudit/memoryAudit` 跨任务命名一致;`upsertMemory` 返回 `{action:"added"|"updated"}` 在 Task 8/9 一致。
