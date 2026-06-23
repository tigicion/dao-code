# 缓存审计(Cache Audit)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 DAO CODE 把每次 API 调用的前缀缓存表现常驻、静默地写进每会话一份的独立 `cache.jsonl`(覆盖主会话/子 agent/fork/后台/三个工具调用,全树汇入根会话同一文件),并提供 `/cache [id]` 命令做事后审计,定位缓存掉的根因。

**Architecture:** 一个自包含的审计 sink 模块(`cache_audit.ts`)负责算四维指纹/变更/delta 并 append 落盘;`runTurn`/`runSubagent` 通过可选依赖注入接收同一个根 sink;`index.ts` 在会话启动时创建根 sink 并注入各调用点;`/cache` 命令离线读 `cache.jsonl` 渲染。

**Tech Stack:** TypeScript (ESM, `.js` import 后缀)、Node `fs`、Vitest。测试单文件:`npx vitest run <file>`;全量:`npm test`;类型:`npm run typecheck`。

参见 spec:`docs/design/specs/2026-06-16-cache-audit-design.md`

---

## File Structure

| 文件 | 职责 | 改动 |
|---|---|---|
| `src/session/cache_audit.ts` | 审计核心:类型 + sink 工厂 + 指纹/变更/delta 计算 + 落盘 | **新建** |
| `src/session/cache_audit.test.ts` | 核心单测 | **新建** |
| `src/agent/loop.ts` | `TurnDeps` 加 `auditSink`/`auditId`;`onUsage` 旁记录 | 修改 |
| `src/agent/subagent.ts` | `SubagentDeps` 加 `auditSink`/`auditAgent`/`auditSubId`,透传进 `runTurn` | 修改 |
| `src/index.ts` | 建根 sink;注入主循环、三个工具调用、子/fork/后台 agent;新增 `/cache` 命令 | 修改 |
| `src/agent/cache_audit_integration.test.ts` | 主+子 agent 写入同一根文件的集成测试 | **新建** |

---

## Task 1: 审计核心模块(cache_audit.ts)

**Files:**
- Create: `src/session/cache_audit.ts`
- Test: `src/session/cache_audit.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/session/cache_audit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCacheAuditSink, divergence, type CacheAuditEvent } from "./cache_audit.js";

const usage = (prompt: number, hit: number) => ({
  prompt_tokens: prompt, completion_tokens: 10, total_tokens: prompt + 10,
  prompt_cache_hit_tokens: hit, prompt_cache_miss_tokens: prompt - hit,
});
const readEvents = (dir: string): (CacheAuditEvent & { ts: number })[] =>
  readFileSync(path.join(dir, "cache.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("cache_audit sink", () => {
  it("appends one event per record with hit ratio and fingerprint", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ca-"));
    const sink = createCacheAuditSink(dir, {});
    sink.record({ agent: "main", depth: 0, turn: 0, model: "pro", usage: usage(1000, 900), sys: "S", tools: "T", tail: "" });
    const ev = readEvents(dir);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.agent).toBe("main");
    expect(ev[0]!.ratio).toBeCloseTo(0.9);
    expect(ev[0]!.hit).toBe(900);
    expect(ev[0]!.changed).toEqual([]); // 首条无可比对象
    expect(typeof ev[0]!.fp.sys).toBe("string");
  });

  it("flags the changed dimension and records a delta when a dim's content changes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ca-"));
    const sink = createCacheAuditSink(dir, {});
    sink.record({ agent: "main", depth: 0, turn: 0, model: "pro", usage: usage(1000, 900), sys: "SYSTEM-A", tools: "T", tail: "" });
    sink.record({ agent: "main", depth: 0, turn: 1, model: "pro", usage: usage(1000, 50), sys: "SYSTEM-B-longer", tools: "T", tail: "" });
    const ev = readEvents(dir);
    expect(ev[1]!.changed).toEqual(["sys"]);
    expect(ev[1]!.delta?.sys?.fromLen).toBe("SYSTEM-A".length);
    expect(ev[1]!.delta?.sys?.toLen).toBe("SYSTEM-B-longer".length);
  });

  it("tracks previous content per agent key (a sub-agent does not pollute main's diff)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ca-"));
    const sink = createCacheAuditSink(dir, {});
    sink.record({ agent: "main", depth: 0, turn: 0, model: "pro", usage: usage(1000, 900), sys: "MAIN", tools: "T", tail: "" });
    sink.record({ agent: "sub", subId: "ab", depth: 1, turn: 0, model: "pro", usage: usage(1000, 0), sys: "SUB", tools: "T", tail: "" });
    sink.record({ agent: "main", depth: 0, turn: 1, model: "pro", usage: usage(1000, 900), sys: "MAIN", tools: "T", tail: "" });
    const ev = readEvents(dir);
    expect(ev[2]!.changed).toEqual([]); // main 的 sys 没变,不受中间 sub 的 SUB 影响
  });

  it("DAO_CACHE_AUDIT=0 produces a no-op sink (no file written)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ca-"));
    const sink = createCacheAuditSink(dir, { DAO_CACHE_AUDIT: "0" });
    sink.record({ agent: "main", depth: 0, turn: 0, model: "pro", usage: usage(1000, 900), sys: "S", tools: "T", tail: "" });
    expect(existsSync(path.join(dir, "cache.jsonl"))).toBe(false);
  });

  it("divergence reports first differing offset and a sample from the new string", () => {
    const d = divergence("hello world", "hello brave world");
    expect(d.firstDiffAt).toBe(6);
    expect(d.sample.startsWith("brave")).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/session/cache_audit.test.ts`
Expected: FAIL —「Cannot find module './cache_audit.js'」。

- [ ] **Step 3: 实现核心模块**

Create `src/session/cache_audit.ts`:

```ts
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Usage } from "../client/types.js";

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
  if (env.DAO_CACHE_AUDIT === "0") return NOOP;
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
      try { appendFileSync(file, JSON.stringify({ ...ev, ts: Date.now() }) + "\n"); } catch { /* 观测落盘失败不影响主流程 */ }
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/session/cache_audit.test.ts`
Expected: PASS（5 个用例全绿）。

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/session/cache_audit.ts src/session/cache_audit.test.ts
git commit -m "feat(cache-audit): 审计核心 sink——四维指纹/变更归因/delta/落盘"
```

---

## Task 2: 接入主 loop(loop.ts)

**Files:**
- Modify: `src/agent/loop.ts`(`TurnDeps` 接口 + `requestAssistant` 签名 + 指纹/onUsage 块)
- Test: `src/agent/loop.test.ts`(追加用例)

- [ ] **Step 1: 写失败测试**

在 `src/agent/loop.test.ts` 末尾追加(若文件顶部尚未引入,补 import):

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCacheAuditSink } from "../session/cache_audit.js";

it("runTurn records a cache-audit event via the injected sink", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loop-ca-"));
  const sink = createCacheAuditSink(dir, {});
  const s = new Session("SYS", "deepseek-v4-pro");
  s.addUser("hi");
  // 复用本测试文件已有的 deps(...) 工厂;它的 streamChat 必须在生成结束前回调 onUsage。
  await runTurn({ ...deps(s), auditSink: sink, auditId: { agent: "main", depth: 0 } });
  const lines = readFileSync(path.join(dir, "cache.jsonl"), "utf8").trim().split("\n");
  expect(lines.length).toBeGreaterThanOrEqual(1);
  expect(JSON.parse(lines[0]!).agent).toBe("main");
});
```

> 注:`loop.test.ts` 已有的 `deps(session)` 工厂里的假 `streamChat` 必须调用 `opts.onUsage?.(...)`。若现有假实现没有回调 onUsage,在其生成器 `return` 前补一行 `opts.onUsage?.({ prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_cache_hit_tokens: 90, prompt_cache_miss_tokens: 10 })`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/agent/loop.test.ts`
Expected: FAIL —`auditSink` 不是 `TurnDeps` 的合法属性(类型错误)或文件未生成。

- [ ] **Step 3: 扩展 TurnDeps 接口**

在 `src/agent/loop.ts` 顶部 import 区加:

```ts
import type { CacheAuditSink, CacheAuditInput } from "../session/cache_audit.js";
```

在 `TurnDeps` 接口内(`background?: boolean;` 之后)加:

```ts
  // 缓存审计:每次 API 调用把命中/指纹/变更落进根会话 cache.jsonl。省略=不审计。
  auditSink?: CacheAuditSink;
  // 本 runTurn 在 agent 树中的身份(main/子/fork/后台);depth 用于 agentKey 分桶。
  auditId?: { agent: CacheAuditInput["agent"]; subId?: string; depth: number };
```

- [ ] **Step 4: 给 requestAssistant 传入回合号,并在指纹处记原始内容、onUsage 处落盘**

把 `requestAssistant` 的签名改为接收 `turn`:

```ts
  const requestAssistant = async (tools: ReturnType<typeof apiToolsForMode>, turn: number): Promise<AssistantMessage> => {
```

把现有指纹块(`loop.ts:104-110` 的 `session.notePrefix({...})`)替换为:先算四维原始内容,再喂给 notePrefix:

```ts
      // P1-47 缓存归因 + 缓存审计:先算四维原始内容,notePrefix 与审计共用。
      const sysRaw = typeof session.messages[0]?.content === "string" ? (session.messages[0]!.content as string) : "";
      const toolsRaw = JSON.stringify(tools);
      const tailRaw = `${transient ?? ""} ${advisory ?? ""}`;
      session.notePrefix({
        model,
        sys: cheapHash(sysRaw),
        tools: cheapHash(toolsRaw),
        tail: cheapHash(tailRaw),
      });
```

把现有 `onUsage`(`loop.ts:120`)替换为:

```ts
          onUsage: (u) => {
            session.addUsage(u, model); // B-2 按模型记账
            deps.auditSink?.record({
              agent: deps.auditId?.agent ?? "main",
              ...(deps.auditId?.subId ? { subId: deps.auditId.subId } : {}),
              depth: deps.auditId?.depth ?? 0,
              turn, model, usage: u, sys: sysRaw, tools: toolsRaw, tail: tailRaw,
            });
          },
```

把循环内的调用点(`loop.ts:160` `const assistant = await requestAssistant(tools);`)改为传入 `t`:

```ts
    const assistant = await requestAssistant(tools, t);
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/agent/loop.test.ts`
Expected: PASS（含新用例与原有用例）。

- [ ] **Step 6: 类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 7: 提交**

```bash
git add src/agent/loop.ts src/agent/loop.test.ts
git commit -m "feat(cache-audit): runTurn 接入审计 sink,每次 API 调用落一条"
```

---

## Task 3: 接入子 agent(subagent.ts)

**Files:**
- Modify: `src/agent/subagent.ts`(`SubagentDeps` + `runSubagent` 透传)
- Test: `src/agent/subagent.test.ts`(追加用例)

- [ ] **Step 1: 写失败测试**

在 `src/agent/subagent.test.ts` 末尾追加(import 按文件现状补齐):

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCacheAuditSink } from "../session/cache_audit.js";

it("runSubagent forwards the audit sink with sub identity into runTurn", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sub-ca-"));
  const sink = createCacheAuditSink(dir, {});
  let captured: { auditId?: { agent: string; subId?: string; depth: number }; auditSink?: unknown } = {};
  await runSubagent({
    ...subDeps(), // 复用本测试已有的最小 deps 工厂
    auditSink: sink,
    auditAgent: "sub",
    auditSubId: "zz",
    runTurn: async (d) => { captured = d as typeof captured; }, // 截获透传的 deps
  });
  expect(captured.auditSink).toBe(sink);
  expect(captured.auditId?.agent).toBe("sub");
  expect(captured.auditId?.subId).toBe("zz");
  expect(captured.auditId?.depth).toBe(1); // ctx.subagentDepth(0)+1
});
```

> 注:若 `subagent.test.ts` 尚无 `subDeps()` 工厂,新建一个返回 `SubagentDeps` 最小实现的本地函数;其 `ctx` 用 `{ subagentDepth: 0, readFiles: new Set(), readMeta: new Map() } as any`,其余字段给空实现/占位即可(本用例只验证透传,不真正请求)。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/agent/subagent.test.ts`
Expected: FAIL —`auditSink`/`auditAgent` 不是 `SubagentDeps` 的合法属性。

- [ ] **Step 3: 扩展 SubagentDeps 并透传**

在 `src/agent/subagent.ts` 顶部 import 区加:

```ts
import type { CacheAuditSink } from "../session/cache_audit.js";
```

在 `SubagentDeps` 接口内(`forkMessages?` 之后)加:

```ts
  auditSink?: CacheAuditSink; // 指向【根会话】的同一 sink → 子代理记录也写进根 cache.jsonl
  auditAgent?: "sub" | "fork" | "bg"; // 本子代理在树中的身份(默认 sub)
  auditSubId?: string; // 本子代理短 id(用于 agentKey 分桶与渲染)
```

在 `runSubagent` 内的 `deps.runTurn({...})` 调用里(`subagent.ts:40-54`),把 `ctx` 那行的 depth 计算抽出复用,并加 audit 注入。具体:把第 45 行附近改为先算 depth,再在 deps 对象里加 `auditSink`/`auditId`:

```ts
  const subDepth = (deps.ctx.subagentDepth ?? 0) + 1;
  await deps.runTurn({
    session: sub,
    config: deps.config,
    registry: deps.registry,
    ctx: { ...deps.ctx, subagentDepth: subDepth, readFiles: new Set(), readMeta: new Map() },
    gate: deps.gate,
    streamChat: deps.streamChat,
    executeToolCalls: deps.executeToolCalls,
    write: deps.write,
    signal: deps.signal,
    drainPending: deps.drainPending,
    background: true,
    maxTurns: 200,
    ...(deps.auditSink ? { auditSink: deps.auditSink, auditId: { agent: deps.auditAgent ?? "sub", subId: deps.auditSubId, depth: subDepth } } : {}),
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/agent/subagent.test.ts`
Expected: PASS。

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/agent/subagent.ts src/agent/subagent.test.ts
git commit -m "feat(cache-audit): 子代理透传根 sink + sub/fork/bg 身份"
```

---

## Task 4: 在 index.ts 创建根 sink 并注入各调用点

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: import 与创建根 sink**

在 `src/index.ts` 顶部 import 区(挨着 `./session/log.js` 那行)加:

```ts
import { createCacheAuditSink } from "./session/cache_audit.js";
```

在 `const store = createSessionStore(sessionsDir, resumeId);`(`index.ts:862`)之后加:

```ts
      // 缓存审计:每会话一个根 sink,主+子+fork+后台+工具调用全写进 store.dir/cache.jsonl。
      const cacheSink = createCacheAuditSink(store.dir);
```

- [ ] **Step 2: 注入主循环 runTurn**

在两处主 `runTurn({...})` 调用(`index.ts:741` 与 `index.ts:888`)的 deps 对象里,各加一行(放在对象末尾、`})` 之前):

```ts
        auditSink: cacheSink,
        auditId: { agent: "main", depth: 0 },
```

> 这两处都跑在主 `session` 上,身份同为 `main`。

- [ ] **Step 3: 注入三个工具调用的 onUsage**

工具调用是单发、无工具集,审计只取命中数字(身份用于区分),四维原始内容传空串:

classifier(`index.ts:458` 的 onUsage)改为:

```ts
      onUsage: (u) => {
        session.addUsage(u, process.env.DAO_CLASSIFIER_MODEL || "deepseek-v4-flash");
        cacheSink.record({ agent: "classifier", depth: 0, turn: 0, model: process.env.DAO_CLASSIFIER_MODEL || "deepseek-v4-flash", usage: u, sys: "", tools: "", tail: "" });
      },
```

summary(`index.ts:693` 的 onUsage)改为:

```ts
      onUsage: (u) => {
        session.addUsage(u, process.env.DAO_SUMMARY_MODEL || FLASH_MODEL);
        cacheSink.record({ agent: "summary", depth: 0, turn: 0, model: process.env.DAO_SUMMARY_MODEL || FLASH_MODEL, usage: u, sys: "", tools: "", tail: "" });
      },
```

distill(`index.ts:786` 的 onUsage)改为:

```ts
        onUsage: (u) => {
          session.addUsage(u as never, distillModel);
          cacheSink.record({ agent: "distill", depth: 0, turn: 0, model: distillModel, usage: u as never, sys: "", tools: "", tail: "" });
        },
```

- [ ] **Step 4: 注入子/fork/后台 agent**

`ctx.runSubagent`(`index.ts:556` 的 `runSubagent({...})`)deps 对象末尾加:

```ts
      auditSink: cacheSink,
      auditAgent: "sub",
      auditSubId: Math.random().toString(36).slice(2, 6),
```

`ctx.runForkAgent`(`index.ts:588` 的 `runSubagent({...})`)deps 对象末尾加:

```ts
      auditSink: cacheSink, auditAgent: "fork", auditSubId: Math.random().toString(36).slice(2, 6),
```

后台 agent 走 `ctx.runSubagent`(`index.ts:600`),已自动带 `sub` 身份与 sink;无需额外改。如需在渲染中区分后台,可后续增强,本期 YAGNI。

- [ ] **Step 5: 类型检查 + 全量测试**

Run: `npm run typecheck && npm test`
Expected: typecheck 无错误;既有测试全绿(本步未加新测试,Task 6 做集成验证)。

- [ ] **Step 6: 提交**

```bash
git add src/index.ts
git commit -m "feat(cache-audit): 会话启动建根 sink,注入主循环/三工具调用/子-fork-后台 agent"
```

---

## Task 5: `/cache [id]` 审计命令

**Files:**
- Modify: `src/index.ts`(内联命令处理器,挨着 `/permissions`、`/resume`)

- [ ] **Step 1: 在命令处理器加 /cache 分支**

在 `index.ts` 内联命令链中(`if (name === "permissions") {...}` 之后,`if (name === "resume")` 之前)插入:

```ts
          if (name === "cache") {
            const id = line.trim().split(/\s+/)[1];
            const dir = id ? path.join(sessionsDir, id) : store.dir;
            const file = path.join(dir, "cache.jsonl");
            let raw: string;
            try { raw = readFileSync(file, "utf8"); }
            catch { return { handled: true, output: `无缓存审计数据:${file}\n(常驻静默记录;若设了 DAO_CACHE_AUDIT=0 则未记录)` }; }
            const evs = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown> & { ts: number });
            if (evs.length === 0) return { handled: true, output: `缓存审计为空:${file}` };
            const TTL_MS = Number(process.env.DAO_CACHE_TTL_MS) || 5 * 60 * 1000;
            const rows: string[] = [];
            let prevTs = 0;
            for (const e of evs) {
              const who = e.agent === "main" ? "main" : `${e.agent}${e.subId ? `#${e.subId}` : ""}@${e.depth}`;
              const pct = ((e.ratio as number) * 100).toFixed(0).padStart(3);
              const changed = e.changed as string[];
              const idle = prevTs ? e.ts - prevTs : 0;
              let flag = "";
              if (changed.length) flag = `⚠ 破:${changed.join("/")}`;
              else if ((e.ratio as number) < 0.3 && (e.prompt as number) >= 4000 && idle > TTL_MS) flag = `· TTL过期(空闲${(idle / 60000).toFixed(1)}min)`;
              rows.push(`  t${e.turn} ${who.padEnd(12)} ${String(e.prompt).padStart(7)}tok 命中${pct}% ${flag}`);
              prevTs = e.ts;
            }
            const head = `缓存审计 · 会话 ${id ?? store.id}\n  文件:${file}\n  记录数:${evs.length}\n`;
            return { handled: true, output: head + rows.join("\n") + "\n(⚠破=某前缀维变化;TTL过期=四维稳但空闲超时,非bug。详查 cache.jsonl 的 delta 字段)" };
          }
```

> `readFileSync` 与 `path` 在 `index.ts` 顶部已 import(确认 `readFileSync` 在 `node:fs` 引入清单里;若缺则补)。

- [ ] **Step 2: 把 /cache 加进帮助清单**

在 `src/commands/commands.ts:48` 的 `/cost 用量` 之后补 ` · /cache 缓存审计`:

```ts
        ...原文 .../cost 用量 · /cache 缓存审计 · /exit 退出",
```

- [ ] **Step 3: 手动冒烟(可选,需真实 key)**

Run: `npm run typecheck`
Expected: 无错误。

(真实跑:`npm run dev` 起会话发一两轮 → 输入 `/cache` → 应看到逐轮命中率表 + 会话 id + 文件路径。)

- [ ] **Step 4: 提交**

```bash
git add src/index.ts src/commands/commands.ts
git commit -m "feat(cache-audit): /cache [id] 命令——逐轮命中率/破缓存维度/TTL 标注"
```

---

## Task 6: 集成测试(主+子 agent 同一根文件)

**Files:**
- Create: `src/agent/cache_audit_integration.test.ts`

- [ ] **Step 1: 写集成测试**

Create `src/agent/cache_audit_integration.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCacheAuditSink, type CacheAuditEvent } from "../session/cache_audit.js";

// 验证设计核心:主与子 agent 的记录写进【同一个】根 cache.jsonl,且身份/分桶正确。
describe("cache-audit integration: whole tree into one root file", () => {
  it("main and sub records land in the same root cache.jsonl with correct identities", () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ca-int-"));
    const sink = createCacheAuditSink(rootDir, {}); // 同一个 sink 传给主与子
    const u = (p: number, h: number) => ({ prompt_tokens: p, completion_tokens: 5, total_tokens: p + 5, prompt_cache_hit_tokens: h, prompt_cache_miss_tokens: p - h });
    // 模拟主回合
    sink.record({ agent: "main", depth: 0, turn: 0, model: "pro", usage: u(20000, 19000), sys: "SYS", tools: "TLS", tail: "" });
    // 模拟子代理两回合(同一根 sink)
    sink.record({ agent: "sub", subId: "ab", depth: 1, turn: 0, model: "pro", usage: u(20000, 0), sys: "SUBSYS", tools: "TLS", tail: "" });
    sink.record({ agent: "sub", subId: "ab", depth: 1, turn: 1, model: "pro", usage: u(20500, 19500), sys: "SUBSYS", tools: "TLS", tail: "" });
    // 模拟主第二回合,sys 被改写(破缓存)
    sink.record({ agent: "main", depth: 0, turn: 1, model: "pro", usage: u(21000, 1000), sys: "SYS-MUTATED", tools: "TLS", tail: "" });

    const evs = readFileSync(path.join(rootDir, "cache.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as CacheAuditEvent);
    expect(evs).toHaveLength(4);
    // 全部在一个文件里
    expect(evs.filter((e) => e.agent === "main")).toHaveLength(2);
    expect(evs.filter((e) => e.agent === "sub")).toHaveLength(1 + 1);
    // 子代理身份正确
    expect(evs[1]!.subId).toBe("ab");
    expect(evs[1]!.depth).toBe(1);
    // 主第二回合归因到 sys 破缓存,且不被中间子代理的 SUBSYS 干扰
    expect(evs[3]!.changed).toEqual(["sys"]);
    expect(evs[3]!.delta?.sys).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认通过**

Run: `npx vitest run src/agent/cache_audit_integration.test.ts`
Expected: PASS。

- [ ] **Step 3: 全量回归**

Run: `npm test && npm run typecheck`
Expected: 全绿、无类型错误。

- [ ] **Step 4: 提交**

```bash
git add src/agent/cache_audit_integration.test.ts
git commit -m "test(cache-audit): 主+子代理写入同一根 cache.jsonl 的集成验证"
```

---

## Self-Review(已执行)

**Spec 覆盖:**
- 独立 `cache.jsonl` 落会话目录 → Task 1(文件名/路径)+ Task 4(`store.dir`)。✅
- 全树单流汇聚(主+子+fork+后台+三工具调用)→ Task 4 各注入点;后台经 `runSubagent` 自动带。✅
- 每条记录四维指纹+delta+ts+树身份 → Task 1 schema。✅
- 常驻静默写 + `DAO_CACHE_AUDIT=0` 开关 → Task 1 `NOOP`。✅
- `/cache [id]` 分析、默认当前会话、打印 id+路径、破缓存维度、TTL 判定 → Task 5。✅
- 定位根因(真破缓存 vs TTL)→ Task 5 渲染 + delta 字段。✅
- fork 验证前提(父子同文件、指纹可比)→ Task 3/4 + Task 6 集成测试。✅
- 测试策略四项(sink 单测/集成/开关回归/fork 指纹)→ Task 1、6 覆盖;fork 指纹比对随父子同文件天然支持。✅

**占位符扫描:** 无 TBD/TODO;每个代码步给了完整代码。✅

**类型一致性:** `CacheAuditInput`/`CacheAuditEvent`/`CacheAuditSink`/`createCacheAuditSink`/`divergence` 在 Task 1 定义,Task 2/3/4/6 用法一致;`auditSink`/`auditId`/`auditAgent`/`auditSubId` 命名跨 Task 一致;`agent` 取值集合(main/sub/fork/bg/classifier/summary/distill)各处一致。✅

**已知边界(spec 已声明):** DeepSeek 只回 hit/miss 总量,审计定位到"哪一维"为止,token 级断点属 v2。
