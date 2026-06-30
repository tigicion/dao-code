# 记忆效果评测 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建一套可复跑的记忆效果评测(提取 + 召回),用「金标准 + LLM 评审」双轨,基于真实(脱敏)数据,直接调记忆函数接缝跑真实 V4 Pro,产基线报告并固化进仓库当回归。

**Architecture:** 新建 `evals/memory/`,用 **TypeScript + tsx** 写(不同于现有 `evals/*.mjs` 靠 spawn 子进程——本评测直接 import `src/` 的 TS 函数 `reflect`/`distill`/`select*`/`parseMemoryFile`,需要类型与 tsx loader)。纯逻辑(transcript/redact/metrics/judge 解析)进 vitest 单测(CI、零 API);打分跑批 `run.ts` 经 tsx 手动触发、走 profile 鉴权、调真实模型、产 `report.md`。

**Tech Stack:** TypeScript(ESM,`.js` import 后缀);tsx(`node_modules/.bin/tsx`);vitest;复用 `src/` 现有:`reflect`(`src/agent/unified_reflect.ts`)、`distill`(`src/memory/distill.ts`)、注入选择(`src/memory/inject.ts`)、`parseMemoryFile`/`serializeMemory`(`src/memory/frontmatter.ts`)、`validateMemory`(`src/memory/validate.ts`)、`loadAllMemories`/`routeScope`(`src/memory/store.ts`)、`streamChat`(`src/client/client.ts`)、`resolveCredential`(`src/config/credential.ts`)、`loadProfiles`(`src/config/profiles_store.ts`)、`runtimeKeychain`/`noopKeychain`/`keychainAvailable`(`src/config/keychain.ts`)、`findSecrets`(`src/permissions/secrets.ts`)。

## Global Constraints

- 语言 TypeScript,ESM:**import `src/` 模块一律带 `.js` 后缀**(如 `../../../src/agent/unified_reflect.js`),注释中文。
- 评测代码放 `evals/memory/`;库代码 `evals/memory/lib/*.ts`;单测 `evals/memory/**/*.test.ts`(需在 `vitest.config.ts` 的 `include` 加 `"evals/**/*.test.ts"`)。
- 单测**零 API**:judge / reflect / distill 一律注入 fake `streamChat`(沿用 `src` 测试的 `fakeStream` 模式)。打分跑批走真实模型,**不进 CI**。
- git commit **不加任何 AI 署名**。
- 结束态:`npx tsc --noEmit -p tsconfig.json` 干净 + `npx vitest run` 全量绿。
- **真实数据脱敏**:进仓 fixture 必须脱敏(`findSecrets` 抠密钥 + 路径归一 + 敏感专名替换),且保留耐久事实语义。真实本地数据走 `--local` 不进仓。
- **金标制备是 controller 职责**:`fixtures/` 里的 `gold.json` / `context.json` 由 controller(非 implementer 子代理)从真实 session 起草、用户抽查定稿。implementer 子代理只建**格式 + 合成样例 fixture**;真实金标在执行期由 controller 单独产出并提交。

---

## 文件结构

```
evals/memory/
  run.ts                  # 跑批入口(tsx):extract|recall|both,--local
  extract.ts              # 提取评测:reflect/distill(真实) → 打分
  recall.ts               # 召回评测:注入选择(真实) → A 确定性闸 + B 相关性诊断
  report.ts               # 纯:把结果聚合成 report.md 文本
  lib/
    types.ts              # 共享类型:GoldFile / RecallContext / JudgeResult / EvalConfig 等
    transcript.ts         # events.jsonl 事件 → messages[];窗口截断(纯)
    redact.ts             # 脱敏器(纯,离线产 fixture 用)
    metrics.ts            # P/R/F1、aggregate、majorityVote、提取/召回汇总(纯)
    judge.ts              # LLM 评审器:judge() + 三个 rubric(streamChat 可注入)
    creds.ts              # 取 profile 凭证 → { streamChat config, model }
  fixtures/
    extract/<case>/conversation.jsonl + gold.json
    recall/<case>/store/*.md + context.json
  runs/                   # 跑批证据(gitignore)
  report.md               # 生成(gitignore)
  README.md
  *.test.ts               # 纯逻辑单测(进 CI)
```

---

## Task 1: 骨架 + vitest include + 共享类型

**Files:**
- Modify: `vitest.config.ts`(include 加 `"evals/**/*.test.ts"`)
- Create: `evals/memory/lib/types.ts`
- Create: `evals/memory/lib/types.test.ts`
- Create: `evals/memory/.gitignore`(`runs/` 与 `report.md`)

**Interfaces:**
- Produces:
  - `interface GoldFact { text: string; type: MemoryType; scope: "project"|"user"|"knowledge"; profile?: boolean }`
  - `interface ExtractGold { existing: { title: string; text: string }[]; mustExtract: GoldFact[]; mustNot: string[]; }`
  - `interface RecallContext { task: string; valueGold: string[]; relevanceGold: string[] }`
  - `interface JudgeResult { scores: Record<string, number>; verdicts: Record<string, unknown>; rationale: string }`
  - `interface EvalConfig { model: string; baseUrl: string; apiKey: string; judgeK: number }`

- [ ] **Step 1: 写失败测试** `evals/memory/lib/types.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { isGoldFact } from "./types.js";

describe("types 守卫", () => {
  it("isGoldFact 认结构完整的事实、拒缺字段", () => {
    expect(isGoldFact({ text: "x", type: "user", scope: "user" })).toBe(true);
    expect(isGoldFact({ text: "x", type: "user" })).toBe(false);
    expect(isGoldFact(null)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑红** — `npx vitest run evals/memory/lib/types.test.ts` → FAIL(找不到模块 / include 未含)

- [ ] **Step 3: 实现**
  - `vitest.config.ts` include 改为:`include: ["src/**/*.test.ts", "src/**/*.test.tsx", "evals/**/*.test.mjs", "evals/**/*.test.ts"]`
  - `evals/memory/lib/types.ts`:

```ts
// 记忆效果评测的共享类型。MemoryType 从 src 复用以对齐 scope 路由。
import type { MemoryType } from "../../../src/memory/types.js";

export interface GoldFact { text: string; type: MemoryType; scope: "project" | "user" | "knowledge"; profile?: boolean; }
export interface ExtractGold { existing: { title: string; text: string }[]; mustExtract: GoldFact[]; mustNot: string[]; }
export interface RecallContext { task: string; valueGold: string[]; relevanceGold: string[]; }
export interface JudgeResult { scores: Record<string, number>; verdicts: Record<string, unknown>; rationale: string; }
export interface EvalConfig { model: string; baseUrl: string; apiKey: string; judgeK: number; }

export function isGoldFact(x: unknown): x is GoldFact {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.text === "string" && typeof o.type === "string" && typeof o.scope === "string";
}
```
  - `evals/memory/.gitignore`:
```
runs/
report.md
```

- [ ] **Step 4: 跑绿** — `npx vitest run evals/memory/lib/types.test.ts` → PASS;`npx tsc --noEmit -p tsconfig.json` → 干净

- [ ] **Step 5: 提交**
```bash
git add vitest.config.ts evals/memory/lib/types.ts evals/memory/lib/types.test.ts evals/memory/.gitignore
git commit -m "feat(eval): 记忆效果评测骨架 + 共享类型 + vitest 收 evals/**/*.test.ts"
```

---

## Task 2: 会话适配器 transcript.ts

**Files:**
- Create: `evals/memory/lib/transcript.ts`
- Create: `evals/memory/lib/transcript.test.ts`

**Interfaces:**
- Consumes: 无(纯)
- Produces:
  - `type RawEvent = { t: "user"; text: string } | { t: "assistant"; content: string | null; toolCalls?: { name: string; args: string }[] } | { t: "tool_result"; name: string; ok?: boolean; content: string } | { t: "turn_end" } | { t: "notice"; text: string }`
  - `toMessages(events: RawEvent[], opts?: { toolResultCap?: number }): { role: string; content: string }[]`
  - `windowMessages(msgs: { role: string; content: string }[], maxChars?: number): { role: string; content: string }[]`
  - `parseJsonl(raw: string): RawEvent[]`

- [ ] **Step 1: 写失败测试** `transcript.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { toMessages, windowMessages, parseJsonl } from "./transcript.js";

describe("toMessages 事件映射", () => {
  it("user → user;assistant(content)→assistant;tool_result → 截断的 user 摘要;turn_end/notice 丢弃", () => {
    const ev = [
      { t: "user", text: "做个滑梯游戏" },
      { t: "assistant", content: "好的", toolCalls: [{ name: "list_dir", args: "{\"path\":\"/x\"}" }] },
      { t: "tool_result", name: "list_dir", ok: true, content: "a\n".repeat(5000) },
      { t: "turn_end" },
      { t: "notice", text: "[反思:...]" },
    ] as const;
    const msgs = toMessages(ev as any, { toolResultCap: 100 });
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[2]!.content.length).toBeLessThan(160);          // tool_result 被截断
    expect(msgs[2]!.content).toContain("list_dir");
  });

  it("assistant content=null 时用 toolCalls 摘要(含工具名)", () => {
    const msgs = toMessages([{ t: "assistant", content: null, toolCalls: [{ name: "todo_write", args: "{}" }] }] as any);
    expect(msgs[0]!.role).toBe("assistant");
    expect(msgs[0]!.content).toContain("todo_write");
  });
});

describe("windowMessages 尾窗", () => {
  it("超长时只保留尾部、总量受限", () => {
    const big = Array.from({ length: 50 }, (_, i) => ({ role: "user", content: "x".repeat(1000) + `#${i}` }));
    const out = windowMessages(big, 5000);
    const total = out.reduce((n, m) => n + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(5000);
    expect(out[out.length - 1]!.content).toContain("#49");      // 尾部保留
  });
});

describe("parseJsonl", () => {
  it("逐行解析、跳过坏行", () => {
    const raw = '{"t":"user","text":"a"}\n坏行\n{"t":"turn_end"}\n';
    expect(parseJsonl(raw).length).toBe(2);
  });
});
```

- [ ] **Step 2: 跑红** — `npx vitest run evals/memory/lib/transcript.test.ts` → FAIL

- [ ] **Step 3: 实现** `transcript.ts`

```ts
// 真实 session 的 events.jsonl(见 src/session/log.ts 的事件形状)→ reflect/distill 吃的 messages[]。
export type RawEvent =
  | { t: "user"; text: string }
  | { t: "assistant"; content: string | null; toolCalls?: { name: string; args: string }[] }
  | { t: "tool_result"; name: string; ok?: boolean; content: string }
  | { t: "turn_end" }
  | { t: "notice"; text: string };

const TOOL_RESULT_CAP = 800; // 单条工具结果截断,避免喂进去爆长

export function parseJsonl(raw: string): RawEvent[] {
  const out: RawEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as RawEvent); } catch { /* 坏行跳过 */ }
  }
  return out;
}

function toolCallSummary(calls?: { name: string; args: string }[]): string {
  if (!calls || !calls.length) return "";
  return "[调用工具] " + calls.map((c) => c.name).join(", ");
}

export function toMessages(events: RawEvent[], opts?: { toolResultCap?: number }): { role: string; content: string }[] {
  const cap = opts?.toolResultCap ?? TOOL_RESULT_CAP;
  const msgs: { role: string; content: string }[] = [];
  for (const e of events) {
    if (e.t === "user") msgs.push({ role: "user", content: e.text });
    else if (e.t === "assistant") {
      const body = e.content && e.content.trim() ? e.content : toolCallSummary(e.toolCalls);
      if (body) msgs.push({ role: "assistant", content: body });
    } else if (e.t === "tool_result") {
      const c = e.content.length > cap ? e.content.slice(0, cap) + "…(截断)" : e.content;
      msgs.push({ role: "user", content: `[工具 ${e.name} 结果] ${c}` });
    }
    // turn_end / notice:丢弃(notice 是反思注入痕迹,不该喂回模型)
  }
  return msgs;
}

export function windowMessages(msgs: { role: string; content: string }[], maxChars = 24000): { role: string; content: string }[] {
  const out: { role: string; content: string }[] = [];
  let total = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (total + m.content.length > maxChars) break;
    out.unshift(m);
    total += m.content.length;
  }
  return out;
}
```

- [ ] **Step 4: 跑绿** — `npx vitest run evals/memory/lib/transcript.test.ts` → PASS

- [ ] **Step 5: 提交**
```bash
git add evals/memory/lib/transcript.ts evals/memory/lib/transcript.test.ts
git commit -m "feat(eval): transcript 适配器(events.jsonl→messages + 尾窗截断)"
```

---

## Task 3: 脱敏器 redact.ts

**Files:**
- Create: `evals/memory/lib/redact.ts`
- Create: `evals/memory/lib/redact.test.ts`

**Interfaces:**
- Consumes: `findSecrets`(`src/permissions/secrets.ts`),`RawEvent`(transcript.ts)
- Produces: `redactText(s: string, rules?: { homedir?: string; nameMap?: Record<string, string> }): string`;`redactEvents(events: RawEvent[], rules?): RawEvent[]`

- [ ] **Step 1: 写失败测试** `redact.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { redactText, redactEvents } from "./redact.js";

describe("redactText", () => {
  it("抠密钥、归一 home 路径、替换专名,保留普通语义", () => {
    const r = redactText("key sk-ABCDEFGHIJKLMNOP1234 在 /Users/alice/Proj/slide 里做 PeppaSlide", {
      homedir: "/Users/alice", nameMap: { PeppaSlide: "GameX", slide: "projX" },
    });
    expect(r).not.toContain("sk-ABCDEFGHIJKLMNOP1234");
    expect(r).toContain("~/Proj/projX");
    expect(r).toContain("GameX");
    expect(r).toContain("做");                 // 普通语义保留
  });
});

describe("redactEvents", () => {
  it("对 user/assistant/tool_result 文本逐一脱敏", () => {
    const out = redactEvents([{ t: "user", text: "/Users/alice/x sk-ABCDEFGHIJKLMNOP1234" }] as any, { homedir: "/Users/alice" });
    expect((out[0] as any).text).toContain("~/x");
    expect((out[0] as any).text).not.toContain("sk-ABCDEFGHIJKLMNOP1234");
  });
});
```

- [ ] **Step 2: 跑红** — `npx vitest run evals/memory/lib/redact.test.ts` → FAIL

- [ ] **Step 3: 实现** `redact.ts`

```ts
// 进仓 fixture 脱敏:抠密钥 + 归一 home 路径 + 按映射替换敏感专名。保留耐久事实语义。
// 离线产 fixture 时跑一次,不在评测热路径。
import { findSecrets } from "../../../src/permissions/secrets.js";
import type { RawEvent } from "./transcript.js";

export function redactText(s: string, rules?: { homedir?: string; nameMap?: Record<string, string> }): string {
  let out = s;
  // 1) 密钥:用 findSecrets 命中的子串替换成占位
  for (const sec of findSecrets(out)) out = out.split(sec).join("‹REDACTED-SECRET›");
  // 2) home 路径归一
  if (rules?.homedir) out = out.split(rules.homedir).join("~");
  // 3) 专名映射(长 key 先替,避免子串冲突)
  for (const [from, to] of Object.entries(rules?.nameMap ?? {}).sort((a, b) => b[0].length - a[0].length)) {
    out = out.split(from).join(to);
  }
  return out;
}

export function redactEvents(events: RawEvent[], rules?: { homedir?: string; nameMap?: Record<string, string> }): RawEvent[] {
  return events.map((e) => {
    if (e.t === "user") return { ...e, text: redactText(e.text, rules) };
    if (e.t === "assistant") return { ...e, content: e.content ? redactText(e.content, rules) : e.content };
    if (e.t === "tool_result") return { ...e, content: redactText(e.content, rules) };
    return e;
  });
}
```
> 注:若 `findSecrets` 返回的是带位置的对象而非字符串,改用其 `.value`/`.match` 字段;实现时以 `src/permissions/secrets.ts` 实际签名为准(已知 `reflect` 里用法是 `findSecrets(text).length`,返回数组)。

- [ ] **Step 4: 跑绿** — `npx vitest run evals/memory/lib/redact.test.ts` → PASS

- [ ] **Step 5: 提交**
```bash
git add evals/memory/lib/redact.ts evals/memory/lib/redact.test.ts
git commit -m "feat(eval): 脱敏器(密钥/路径/专名,保留语义)"
```

---

## Task 4: 指标 metrics.ts

**Files:**
- Create: `evals/memory/lib/metrics.ts`
- Create: `evals/memory/lib/metrics.test.ts`

**Interfaces:**
- Produces:
  - `precisionRecall(predicted: Set<string>, gold: Set<string>): { p: number; r: number; f1: number }`
  - `aggregate(xs: number[]): { median: number; mean: number; stdev: number; min: number; max: number }`
  - `majorityVote(bs: boolean[]): { value: boolean; agreement: number }`
  - `relevanceGap(injected: Set<string>, relevanceGold: Set<string>): number` // 相关但未注入的占比

- [ ] **Step 1: 写失败测试** `metrics.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { precisionRecall, aggregate, majorityVote, relevanceGap } from "./metrics.js";

describe("precisionRecall", () => {
  it("标准 P/R/F1", () => {
    const r = precisionRecall(new Set(["a", "b", "x"]), new Set(["a", "b", "c"]));
    expect(r.p).toBeCloseTo(2 / 3); expect(r.r).toBeCloseTo(2 / 3); expect(r.f1).toBeCloseTo(2 / 3);
  });
  it("空预测 → P=0,R=0,不除零", () => {
    const r = precisionRecall(new Set(), new Set(["a"]));
    expect(r.p).toBe(0); expect(r.r).toBe(0); expect(r.f1).toBe(0);
  });
});

describe("aggregate", () => {
  it("中位/均值/极值", () => {
    const a = aggregate([1, 2, 3, 4]);
    expect(a.median).toBe(2.5); expect(a.mean).toBe(2.5); expect(a.min).toBe(1); expect(a.max).toBe(4);
  });
});

describe("majorityVote", () => {
  it("多数票 + 一致率", () => {
    expect(majorityVote([true, true, false])).toEqual({ value: true, agreement: 2 / 3 });
  });
});

describe("relevanceGap", () => {
  it("相关但未注入占比", () => {
    expect(relevanceGap(new Set(["a"]), new Set(["a", "b", "c"]))).toBeCloseTo(2 / 3);
  });
});
```

- [ ] **Step 2: 跑红** — `npx vitest run evals/memory/lib/metrics.test.ts` → FAIL

- [ ] **Step 3: 实现** `metrics.ts`

```ts
// 评测纯指标:P/R/F1、聚合(中位/方差)、多数票、相关性缺口。无 I/O。
export function precisionRecall(predicted: Set<string>, gold: Set<string>): { p: number; r: number; f1: number } {
  let tp = 0;
  for (const x of predicted) if (gold.has(x)) tp++;
  const p = predicted.size ? tp / predicted.size : 0;
  const r = gold.size ? tp / gold.size : 0;
  const f1 = p + r ? (2 * p * r) / (p + r) : 0;
  return { p, r, f1 };
}

export function aggregate(xs: number[]): { median: number; mean: number; stdev: number; min: number; max: number } {
  if (!xs.length) return { median: 0, mean: 0, stdev: 0, min: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  const stdev = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { median, mean, stdev, min: s[0]!, max: s[s.length - 1]! };
}

export function majorityVote(bs: boolean[]): { value: boolean; agreement: number } {
  const t = bs.filter(Boolean).length;
  return { value: t * 2 >= bs.length, agreement: bs.length ? Math.max(t, bs.length - t) / bs.length : 0 };
}

export function relevanceGap(injected: Set<string>, relevanceGold: Set<string>): number {
  if (!relevanceGold.size) return 0;
  let missed = 0;
  for (const x of relevanceGold) if (!injected.has(x)) missed++;
  return missed / relevanceGold.size;
}
```

- [ ] **Step 4: 跑绿** — `npx vitest run evals/memory/lib/metrics.test.ts` → PASS

- [ ] **Step 5: 提交**
```bash
git add evals/memory/lib/metrics.ts evals/memory/lib/metrics.test.ts
git commit -m "feat(eval): 指标(P/R/F1、aggregate、majorityVote、relevanceGap)"
```

---

## Task 5: LLM 评审器 judge.ts

**Files:**
- Create: `evals/memory/lib/judge.ts`
- Create: `evals/memory/lib/judge.test.ts`

**Interfaces:**
- Consumes: `EvalConfig`(types.ts);可注入的 `streamChat`(签名同 `src/client/client.ts` 的 `streamChat`)
- Produces:
  - `parseJudgeJson(raw: string): Record<string, unknown> | null`(容错:抠第一个 `{...}`)
  - `judgeOnce(p: { streamChat; cfg: EvalConfig; prompt: string }): Promise<Record<string, unknown> | null>`
  - rubric 构造器(纯):`factCoveredPrompt(fact, extracted)`、`memoryQualityPrompt(memory)`、`relevancePrompt(task, memoryText)` → string
  - `judgeBool(p, K): Promise<{ value: boolean; agreement: number }>`(跑 K 次 + 多数票)

- [ ] **Step 1: 写失败测试** `judge.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { parseJudgeJson, judgeBool, factCoveredPrompt, memoryQualityPrompt } from "./judge.js";

function fakeStream(text: string) {
  return async function* () { yield { kind: "content", text }; return { role: "assistant", content: text }; }();
}
const cfg = { model: "x", baseUrl: "x", apiKey: "x", judgeK: 3 };

describe("parseJudgeJson", () => {
  it("从含前后噪声的输出里抠出 JSON", () => {
    expect(parseJudgeJson('废话 {"covered":true} 尾巴')).toEqual({ covered: true });
    expect(parseJudgeJson("没有 json")).toBeNull();
  });
});

describe("rubric 构造", () => {
  it("factCoveredPrompt 含事实文本与所有抽出标题", () => {
    const p = factCoveredPrompt({ text: "用户有iPad给2岁孩子做游戏", type: "user", scope: "user" }, [{ title: "T1", text: "x" }]);
    expect(p).toContain("iPad"); expect(p).toContain("T1"); expect(p).toContain("covered");
  });
  it("memoryQualityPrompt 含四维度键", () => {
    const p = memoryQualityPrompt({ title: "T", text: "x" } as any);
    for (const k of ["durable", "typeScopeCorrect", "notCatalogDump", "actionable"]) expect(p).toContain(k);
  });
});

describe("judgeBool K 次多数票", () => {
  it("3 次里 2 真 → value=true、agreement=2/3", async () => {
    let i = 0;
    const outs = ['{"covered":true}', '{"covered":false}', '{"covered":true}'];
    const streamChat = () => fakeStream(outs[i++]!);
    const r = await judgeBool({ streamChat: streamChat as any, cfg, prompt: "x", key: "covered" }, 3);
    expect(r.value).toBe(true); expect(r.agreement).toBeCloseTo(2 / 3);
  });
});
```

- [ ] **Step 2: 跑红** — `npx vitest run evals/memory/lib/judge.test.ts` → FAIL

- [ ] **Step 3: 实现** `judge.ts`

```ts
// LLM 评审器:把 rubric 提示喂给真实模型,强制 JSON,容错解析。非确定性靠 K 次多数票(judgeBool)压。
// streamChat 注入:单测用 fakeStream,跑批用 src 的真实 streamChat。
import type { EvalConfig } from "./types.js";
import { majorityVote } from "./metrics.js";

export function parseJudgeJson(raw: string): Record<string, unknown> | null {
  const i = raw.indexOf("{"); const j = raw.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(raw.slice(i, j + 1)) as Record<string, unknown>; } catch { return null; }
}

export async function judgeOnce(p: { streamChat: (o: any) => AsyncGenerator<any, any>; cfg: EvalConfig; prompt: string }): Promise<Record<string, unknown> | null> {
  const gen = p.streamChat({
    baseUrl: p.cfg.baseUrl, apiKey: p.cfg.apiKey, model: p.cfg.model,
    messages: [{ role: "user", content: p.prompt }],
    extra: { thinking: { type: "disabled" }, temperature: 0 },
  });
  let out = ""; let r = await gen.next();
  while (!r.done) { if (r.value?.kind === "content") out += r.value.text; r = await gen.next(); }
  if (!out && typeof r.value?.content === "string") out = r.value.content;
  return parseJudgeJson(out);
}

export async function judgeBool(
  p: { streamChat: (o: any) => AsyncGenerator<any, any>; cfg: EvalConfig; prompt: string; key: string },
  K: number,
): Promise<{ value: boolean; agreement: number }> {
  const votes: boolean[] = [];
  for (let k = 0; k < K; k++) {
    const j = await judgeOnce({ streamChat: p.streamChat, cfg: p.cfg, prompt: p.prompt });
    votes.push(!!(j && j[p.key] === true));
  }
  return majorityVote(votes);
}

export function factCoveredPrompt(fact: { text: string; type: string; scope: string }, extracted: { title?: string; text: string }[]): string {
  const list = extracted.map((m, i) => `${i + 1}. 标题:${m.title ?? "(无)"} | 正文:${m.text}`).join("\n") || "(本会话没抽出任何记忆)";
  return `判断下面这条【金标事实】是否被任一【抽出记忆】语义覆盖(表述不同但同一事实即算覆盖)。\n` +
    `金标事实:${fact.text}\n\n抽出记忆:\n${list}\n\n` +
    `只输出 JSON:{"covered": true/false, "byTitle": "命中的标题或null", "why": "一句话理由"}`;
}

export function memoryQualityPrompt(memory: { title?: string; text: string; type?: string }): string {
  return `给这条抽出记忆按四维度各打 0-1 分:\n` +
    `记忆:标题=${memory.title ?? "(无)"} 类型=${memory.type ?? "?"} 正文=${memory.text}\n\n` +
    `维度:durable(是否跨会话耐久,非一次性)、typeScopeCorrect(type 与作用域是否合理)、notCatalogDump(是否非目录倾倒/非显而易见)、actionable(下次能否据此行动)。\n` +
    `只输出 JSON:{"durable":0-1,"typeScopeCorrect":0-1,"notCatalogDump":0-1,"actionable":0-1,"why":"一句话"}`;
}

export function relevancePrompt(task: string, memoryText: string): string {
  return `判断这条记忆对当前任务是否【真正相关】(能影响怎么做这个任务)。\n任务:${task}\n记忆:${memoryText}\n\n只输出 JSON:{"relevant": true/false, "why": "一句话"}`;
}
```

- [ ] **Step 4: 跑绿** — `npx vitest run evals/memory/lib/judge.test.ts` → PASS

- [ ] **Step 5: 提交**
```bash
git add evals/memory/lib/judge.ts evals/memory/lib/judge.test.ts
git commit -m "feat(eval): LLM 评审器(rubric + 容错解析 + K 次多数票)"
```

---

## Task 6: 凭证 creds.ts

**Files:**
- Create: `evals/memory/lib/creds.ts`
- Create: `evals/memory/lib/creds.test.ts`

**Interfaces:**
- Consumes: `loadProfiles`(`src/config/profiles_store.ts`)、`resolveCredential`(`src/config/credential.ts`)、`runtimeKeychain`/`noopKeychain`/`keychainAvailable`(`src/config/keychain.ts`)
- Produces: `loadEvalConfig(opts?: { keyFile?: string; judgeK?: number; model?: string }): Promise<EvalConfig>`(无凭证抛清晰错误)

- [ ] **Step 1: 写失败测试** `creds.test.ts`(只测「无 profile 时抛清晰错误」,真实凭证路径不进 CI)

```ts
import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEvalConfig } from "./creds.js";

describe("loadEvalConfig", () => {
  it("config.json 无生效 profile → 抛含『login』提示的错误", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-creds-"));
    const keyFile = path.join(dir, "config.json");
    await fs.writeFile(keyFile, JSON.stringify({ version: 2, activeProfile: "none", profiles: {} }), "utf8");
    await expect(loadEvalConfig({ keyFile })).rejects.toThrow(/login/i);
  });
});
```

- [ ] **Step 2: 跑红** — `npx vitest run evals/memory/lib/creds.test.ts` → FAIL

- [ ] **Step 3: 实现** `creds.ts`

```ts
// 取 profile 凭证给评测用(和交互/现有 evals 同一条路径:loadProfiles + keychain + resolveCredential)。
import os from "node:os";
import path from "node:path";
import { loadProfiles } from "../../../src/config/profiles_store.js";
import { resolveCredential } from "../../../src/config/credential.js";
import { runtimeKeychain, noopKeychain, keychainAvailable } from "../../../src/config/keychain.js";
import type { EvalConfig } from "./types.js";

export async function loadEvalConfig(opts?: { keyFile?: string; judgeK?: number; model?: string }): Promise<EvalConfig> {
  const keyFile = opts?.keyFile ?? path.join(os.homedir(), ".dao", "config.json");
  const cfg = await loadProfiles(keyFile);
  const kc = keychainAvailable() ? runtimeKeychain : noopKeychain;
  const cred = await resolveCredential(cfg, kc);
  if (!cred) throw new Error("评测找不到生效凭证:请先 `dao /login` 或在 ~/.dao/config.json 配 profile。");
  return {
    model: opts?.model ?? process.env.DEEPSEEK_MODEL ?? cred.model,
    baseUrl: cred.baseUrl,
    apiKey: cred.key,
    judgeK: opts?.judgeK ?? Number(process.env.EVAL_JUDGE_K || 3),
  };
}
```

- [ ] **Step 4: 跑绿** — `npx vitest run evals/memory/lib/creds.test.ts` → PASS;`npx tsc --noEmit` → 干净

- [ ] **Step 5: 提交**
```bash
git add evals/memory/lib/creds.ts evals/memory/lib/creds.test.ts
git commit -m "feat(eval): creds(profile→EvalConfig,无凭证清晰报错)"
```

---

## Task 7: 提取评测 extract.ts + 合成 fixture

**Files:**
- Create: `evals/memory/extract.ts`
- Create: `evals/memory/extract.test.ts`
- Create: `evals/memory/fixtures/extract/_synthetic/conversation.jsonl`
- Create: `evals/memory/fixtures/extract/_synthetic/gold.json`

**Interfaces:**
- Consumes: `reflect`(`src/agent/unified_reflect.ts`)、transcript、judge、metrics、types
- Produces:
  - `gradeExtraction(p: { extracted: { title?: string; text: string; type: string }[]; gold: ExtractGold; streamChat; cfg: EvalConfig }): Promise<ExtractScore>`
  - `interface ExtractScore { factRecall: number; profileRecall: number; precision: number; quality: number; perFact: { fact: string; covered: boolean; agreement: number }[] }`
  - `runExtractCase(dir: string, streamChat, cfg): Promise<ExtractScore>`(读 fixture → toMessages → reflect → gradeExtraction)

- [ ] **Step 1: 写失败测试** `extract.test.ts`(用 fake reflect 输出 + fake judge,验打分接线;零 API)

```ts
import { describe, it, expect } from "vitest";
import { gradeExtraction } from "./extract.js";

function fakeStream(text: string) {
  return async function* () { yield { kind: "content", text }; return { role: "assistant", content: text }; }();
}
const cfg = { model: "x", baseUrl: "x", apiKey: "x", judgeK: 1 };

describe("gradeExtraction 接线", () => {
  it("mustExtract 全覆盖、无 mustNot 命中 → recall=1 precision=1", async () => {
    // judge:对覆盖判定恒返回 covered=true;质量恒高;mustNot 判定恒 false
    const streamChat = (o: any) => {
      const prompt = o.messages[0].content as string;
      if (prompt.includes("是否被任一")) return fakeStream('{"covered":true,"why":"x"}');
      if (prompt.includes("四维度")) return fakeStream('{"durable":1,"typeScopeCorrect":1,"notCatalogDump":1,"actionable":1}');
      return fakeStream('{"covered":false}');
    };
    const gold = {
      existing: [],
      mustExtract: [{ text: "用户有iPad给2岁孩子做游戏", type: "user" as const, scope: "user" as const, profile: true }],
      mustNot: [],
    };
    const extracted = [{ title: "画像", text: "用户长期给低龄儿童做iPad游戏", type: "user" }];
    const s = await gradeExtraction({ extracted, gold, streamChat: streamChat as any, cfg });
    expect(s.factRecall).toBe(1);
    expect(s.profileRecall).toBe(1);
    expect(s.precision).toBe(1);
    expect(s.quality).toBeGreaterThan(0.9);
  });

  it("漏掉画像事实 → profileRecall=0", async () => {
    const streamChat = () => fakeStream('{"covered":false,"why":"没覆盖"}');
    const gold = { existing: [], mustExtract: [{ text: "iPad给2岁孩子", type: "user" as const, scope: "user" as const, profile: true }], mustNot: [] };
    const s = await gradeExtraction({ extracted: [], gold, streamChat: streamChat as any, cfg });
    expect(s.profileRecall).toBe(0);
  });
});
```

- [ ] **Step 2: 跑红** — `npx vitest run evals/memory/extract.test.ts` → FAIL

- [ ] **Step 3: 实现** `extract.ts`(注:`runExtractCase` 调真实 `reflect`,但本任务单测只测 `gradeExtraction`;`runExtractCase` 在 Task 9 的 run.ts 串起来后用真实模型手动验)

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { reflect } from "../../src/agent/unified_reflect.js";
import { parseJsonl, toMessages, windowMessages } from "./lib/transcript.js";
import { judgeBool, judgeOnce, factCoveredPrompt, memoryQualityPrompt } from "./lib/judge.js";
import { aggregate } from "./lib/metrics.js";
import type { EvalConfig, ExtractGold } from "./lib/types.js";

export interface ExtractScore {
  factRecall: number; profileRecall: number; precision: number; quality: number;
  perFact: { fact: string; covered: boolean; agreement: number }[];
}

export async function gradeExtraction(p: {
  extracted: { title?: string; text: string; type: string }[];
  gold: ExtractGold; streamChat: (o: any) => AsyncGenerator<any, any>; cfg: EvalConfig;
}): Promise<ExtractScore> {
  const K = p.cfg.judgeK;
  // 1) mustExtract 覆盖(逐条 judge 多数票)
  const perFact: { fact: string; covered: boolean; agreement: number; profile: boolean }[] = [];
  for (const f of p.gold.mustExtract) {
    const v = await judgeBool({ streamChat: p.streamChat, cfg: p.cfg, prompt: factCoveredPrompt(f, p.extracted), key: "covered" }, K);
    perFact.push({ fact: f.text, covered: v.value, agreement: v.agreement, profile: !!f.profile });
  }
  const factRecall = p.gold.mustExtract.length ? perFact.filter((x) => x.covered).length / p.gold.mustExtract.length : 1;
  const profs = perFact.filter((x) => x.profile);
  const profileRecall = profs.length ? profs.filter((x) => x.covered).length / profs.length : 1;
  // 2) mustNot 精确率:抽出的每条若命中任一 mustNot 噪声描述则算误抽
  let noise = 0;
  for (const m of p.extracted) {
    const goldNoise = { existing: [], mustExtract: [], mustNot: p.gold.mustNot };
    const hit = p.gold.mustNot.length
      ? (await judgeBool({ streamChat: p.streamChat, cfg: p.cfg,
          prompt: factCoveredPrompt({ text: "以下任一噪声描述:" + p.gold.mustNot.join(";"), type: "episodic", scope: "project" }, [m]),
          key: "covered" }, K)).value
      : false;
    if (hit) noise++;
    void goldNoise;
  }
  const precision = p.extracted.length ? 1 - noise / p.extracted.length : 1;
  // 3) 单条质量(judge 一次取四维度均值,再对所有记忆取均值)
  const qs: number[] = [];
  for (const m of p.extracted) {
    const j = await judgeOnce({ streamChat: p.streamChat, cfg: p.cfg, prompt: memoryQualityPrompt(m) });
    if (j) {
      const dims = ["durable", "typeScopeCorrect", "notCatalogDump", "actionable"].map((k) => Number(j[k] ?? 0));
      qs.push(dims.reduce((a, b) => a + b, 0) / dims.length);
    }
  }
  const quality = qs.length ? aggregate(qs).mean : 1;
  return { factRecall, profileRecall, precision, quality, perFact: perFact.map(({ fact, covered, agreement }) => ({ fact, covered, agreement })) };
}

export async function runExtractCase(dir: string, streamChat: (o: any) => AsyncGenerator<any, any>, cfg: EvalConfig): Promise<ExtractScore> {
  const gold = JSON.parse(await fs.readFile(path.join(dir, "gold.json"), "utf8")) as ExtractGold;
  const events = parseJsonl(await fs.readFile(path.join(dir, "conversation.jsonl"), "utf8"));
  const messages = windowMessages(toMessages(events));
  const today = new Date().toISOString().slice(0, 10);
  const result = await reflect({ streamChat, config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey }, model: cfg.model, messages, existing: gold.existing, today, fork: false } as any);
  const extracted = result.memories.map((m: any) => ({ title: m.title, text: m.text, type: m.type }));
  return gradeExtraction({ extracted, gold, streamChat, cfg });
}
```
> 注:`runExtractCase` 用 `new Date()` 取 today,仅在跑批(非确定环境)用;单测只覆盖纯接线的 `gradeExtraction`。

合成 fixture `fixtures/extract/_synthetic/conversation.jsonl`(每行一个事件,体现「用户提到 iPad/2岁孩子」+ 噪声):
```
{"t":"user","text":"我用 iPad 持续给我 2 岁的孩子做小游戏,这次想做个滑梯的"}
{"t":"assistant","content":"明白,先看下现有工程结构","toolCalls":[{"name":"list_dir","args":"{}"}]}
{"t":"tool_result","name":"list_dir","ok":true,"content":"GameScene.swift\nproject.yml"}
{"t":"user","text":"对了我喜欢先看完整方案再动手"}
{"t":"turn_end"}
```
`fixtures/extract/_synthetic/gold.json`:
```json
{
  "existing": [],
  "mustExtract": [
    {"text":"用户持续用 iPad 给约 2 岁低龄儿童做游戏","type":"user","scope":"user","profile":true},
    {"text":"用户偏好先看完整方案再动手","type":"feedback","scope":"user","profile":true}
  ],
  "mustNot": ["工程里有 GameScene.swift 和 project.yml 这类一次性目录信息"]
}
```

- [ ] **Step 4: 跑绿** — `npx vitest run evals/memory/extract.test.ts` → PASS

- [ ] **Step 5: 提交**
```bash
git add evals/memory/extract.ts evals/memory/extract.test.ts evals/memory/fixtures/extract/_synthetic
git commit -m "feat(eval): 提取评测打分(覆盖/画像/精确率/质量)+ 合成 fixture"
```

---

## Task 8: 召回评测 recall.ts + 合成 fixture

**Files:**
- Create: `evals/memory/recall.ts`
- Create: `evals/memory/recall.test.ts`
- Create: `evals/memory/fixtures/recall/_synthetic/store/*.md`(2-3 条)
- Create: `evals/memory/fixtures/recall/_synthetic/context.json`

**Interfaces:**
- Consumes: `loadAllMemories`(`src/memory/store.ts`)、`selectForInjection`(`src/memory/inject.ts`)、`validateMemory`(`src/memory/validate.ts`)、judge、metrics、types
- Produces:
  - `gradeRecall(p: { injectedNames: string[]; staleNames: string[]; store: { name: string; text: string }[]; ctx: RecallContext; streamChat; cfg }): Promise<RecallScore>`
  - `interface RecallScore { valuePR: { p: number; r: number; f1: number }; staleLeak: number; relevanceGapValue: number }`
  - `runRecallCase(dir, streamChat, cfg): Promise<RecallScore>`

- [ ] **Step 1: 写失败测试** `recall.test.ts`(fake judge;验 A 轨确定性 + staleLeak + 缺口接线)

```ts
import { describe, it, expect } from "vitest";
import { gradeRecall } from "./recall.js";

function fakeStream(text: string) { return async function* () { yield { kind: "content", text }; return { role: "assistant", content: text }; }(); }
const cfg = { model: "x", baseUrl: "x", apiKey: "x", judgeK: 1 };

describe("gradeRecall", () => {
  it("注入命中 valueGold → P/R 高;stale 泄漏=0;相关性缺口按 judge 算", async () => {
    // judge 对 relevance 恒 true(都相关)
    const streamChat = () => fakeStream('{"relevant":true}');
    const s = await gradeRecall({
      injectedNames: ["a", "b"], staleNames: [],
      store: [{ name: "a", text: "x" }, { name: "b", text: "y" }, { name: "c", text: "z" }],
      ctx: { task: "做滑梯", valueGold: ["a", "b"], relevanceGold: ["a", "b", "c"] },
      streamChat: streamChat as any, cfg,
    });
    expect(s.valuePR.r).toBe(1);
    expect(s.staleLeak).toBe(0);
    expect(s.relevanceGapValue).toBeCloseTo(1 / 3);   // c 相关但没注入
  });

  it("stale 出现在注入集 → staleLeak>0(硬规则违反)", async () => {
    const streamChat = () => fakeStream('{"relevant":false}');
    const s = await gradeRecall({
      injectedNames: ["a", "s1"], staleNames: ["s1"],
      store: [{ name: "a", text: "x" }, { name: "s1", text: "stale" }],
      ctx: { task: "t", valueGold: ["a"], relevanceGold: [] },
      streamChat: streamChat as any, cfg,
    });
    expect(s.staleLeak).toBe(1);
  });
});
```

- [ ] **Step 2: 跑红** — `npx vitest run evals/memory/recall.test.ts` → FAIL

- [ ] **Step 3: 实现** `recall.ts`

```ts
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAllMemories } from "../../src/memory/store.js";
import { selectForInjection } from "../../src/memory/inject.js";
import { validateMemory } from "../../src/memory/validate.js";
import { parseMemoryFile } from "../../src/memory/frontmatter.js";
import { judgeBool, relevancePrompt } from "./lib/judge.js";
import { precisionRecall, relevanceGap } from "./lib/metrics.js";
import type { EvalConfig, RecallContext } from "./lib/types.js";

export interface RecallScore { valuePR: { p: number; r: number; f1: number }; staleLeak: number; relevanceGapValue: number; }

export async function gradeRecall(p: {
  injectedNames: string[]; staleNames: string[];
  store: { name: string; text: string }[]; ctx: RecallContext;
  streamChat: (o: any) => AsyncGenerator<any, any>; cfg: EvalConfig;
}): Promise<RecallScore> {
  const injected = new Set(p.injectedNames);
  // A 轨:valueGold P/R + stale 泄漏(硬规则:stale 不该在注入集)
  const valuePR = precisionRecall(injected, new Set(p.ctx.valueGold));
  const staleLeak = p.staleNames.filter((n) => injected.has(n)).length;
  // B 轨:judge 判 store 每条是否语境相关 → 相关集;相关但未注入 = 缺口
  const relevant = new Set<string>();
  for (const m of p.store) {
    const v = await judgeBool({ streamChat: p.streamChat, cfg: p.cfg, prompt: relevancePrompt(p.ctx.task, m.text), key: "relevant" }, p.cfg.judgeK);
    if (v.value) relevant.add(m.name);
  }
  const relevanceGapValue = relevanceGap(injected, relevant);
  return { valuePR, staleLeak, relevanceGapValue };
}

export async function runRecallCase(dir: string, streamChat: (o: any) => AsyncGenerator<any, any>, cfg: EvalConfig): Promise<RecallScore> {
  const ctx = JSON.parse(await fs.readFile(path.join(dir, "context.json"), "utf8")) as RecallContext;
  const storeDir = path.join(dir, "store");
  const today = new Date().toISOString().slice(0, 10);
  // 临时工作区:让 validateMemory 在无 source 时判 ok(fixture 记忆一般无 source)
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "eval-recall-"));
  const mems = await loadAllMemories(storeDir);
  const validated: { mem: any; verdict: string }[] = [];
  for (const m of mems) { const { verdict } = await validateMemory(m, ws, today); validated.push({ mem: m, verdict }); }
  const liveNames = validated.filter((v) => v.verdict !== "stale").map((v) => v.mem.name);
  const staleNames = validated.filter((v) => v.verdict === "stale").map((v) => v.mem.name);
  const injected = selectForInjection(validated as any, today).map((v: any) => v.mem.name);
  const store = mems.map((m: any) => ({ name: m.name, text: m.text }));
  void liveNames;
  return gradeRecall({ injectedNames: injected, staleNames, store, ctx, streamChat, cfg });
}
```
> 注:`runRecallCase` 用真实 `selectForInjection`/`validateMemory`;单测只覆盖纯接线的 `gradeRecall`。`parseMemoryFile` 已由 `loadAllMemories` 内部调,import 留作类型/未来直读用——若 lint 报未用则删该 import。

合成 fixture `fixtures/recall/_synthetic/store/`(3 个 .md,frontmatter 见 `src/memory/frontmatter.ts`),例 `a.md`:
```markdown
---
name: a
title: 用户偏好先看完整方案
type: feedback
importance: 9
uses: 2
created: 2026-06-01
lastUsed: 2026-06-20
status: active
locked: false
---
用户偏好先看完整方案再动手。
```
`context.json`:
```json
{ "task": "给 2 岁孩子做一个 iPad 滑梯小游戏", "valueGold": ["a","b"], "relevanceGold": ["a","b"] }
```
(`b.md`/`c.md` 类似:b=低龄儿童游戏画像高价值相关、c=某无关技术笔记低价值。)

- [ ] **Step 4: 跑绿** — `npx vitest run evals/memory/recall.test.ts` → PASS

- [ ] **Step 5: 提交**
```bash
git add evals/memory/recall.ts evals/memory/recall.test.ts evals/memory/fixtures/recall/_synthetic
git commit -m "feat(eval): 召回评测(A 价值闸 + stale 泄漏 + B 相关性缺口)+ 合成 fixture"
```

---

## Task 9: 报告 report.ts + 跑批入口 run.ts + README

**Files:**
- Create: `evals/memory/report.ts`
- Create: `evals/memory/report.test.ts`
- Create: `evals/memory/run.ts`
- Create: `evals/memory/README.md`

**Interfaces:**
- Consumes: `ExtractScore`(extract.ts)、`RecallScore`(recall.ts)、`runExtractCase`/`runRecallCase`、`loadEvalConfig`、`streamChat`(`src/client/client.ts`)
- Produces:
  - `formatExtractReport(rows: { case: string; score: ExtractScore }[]): string`(纯)
  - `formatRecallReport(rows: { case: string; score: RecallScore }[]): string`(纯)
  - `run.ts` CLI:`tsx evals/memory/run.ts [extract|recall] [--local]`

- [ ] **Step 1: 写失败测试** `report.test.ts`(纯格式化)

```ts
import { describe, it, expect } from "vitest";
import { formatExtractReport, formatRecallReport } from "./report.js";

describe("report 格式化", () => {
  it("提取报告含画像召回与各 case", () => {
    const out = formatExtractReport([{ case: "slide", score: { factRecall: 0.8, profileRecall: 0.5, precision: 1, quality: 0.9, perFact: [] } }]);
    expect(out).toContain("slide");
    expect(out).toContain("画像召回");
    expect(out).toContain("0.5");
  });
  it("召回报告含相关性缺口", () => {
    const out = formatRecallReport([{ case: "c1", score: { valuePR: { p: 1, r: 1, f1: 1 }, staleLeak: 0, relevanceGapValue: 0.33 } }]);
    expect(out).toContain("相关性缺口");
    expect(out).toContain("0.33");
  });
});
```

- [ ] **Step 2: 跑红** — `npx vitest run evals/memory/report.test.ts` → FAIL

- [ ] **Step 3: 实现**

`report.ts`:
```ts
import type { ExtractScore } from "./extract.js";
import type { RecallScore } from "./recall.js";

export function formatExtractReport(rows: { case: string; score: ExtractScore }[]): string {
  const lines = ["# 提取效果报告", ""];
  for (const r of rows) {
    const s = r.score;
    lines.push(`## ${r.case}`,
      `- 事实召回:${s.factRecall.toFixed(2)}`,
      `- 画像召回:${s.profileRecall.toFixed(2)}`,
      `- 精确率(非噪声):${s.precision.toFixed(2)}`,
      `- 单条质量均分:${s.quality.toFixed(2)}`, "");
    for (const f of s.perFact) lines.push(`  · [${f.covered ? "✓" : "✗"} ${f.agreement.toFixed(2)}] ${f.fact}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function formatRecallReport(rows: { case: string; score: RecallScore }[]): string {
  const lines = ["# 召回效果报告", ""];
  for (const r of rows) {
    const s = r.score;
    lines.push(`## ${r.case}`,
      `- 价值 P/R/F1:${s.valuePR.p.toFixed(2)} / ${s.valuePR.r.toFixed(2)} / ${s.valuePR.f1.toFixed(2)}`,
      `- stale 泄漏(应为0):${s.staleLeak}`,
      `- 相关性缺口(诊断,越低越好):${s.relevanceGapValue.toFixed(2)}`, "");
  }
  return lines.join("\n");
}
```

`run.ts`(跑批入口,真实模型;遍历 fixtures/ 或 --local 真实 session):
```ts
#!/usr/bin/env tsx
// 记忆效果评测跑批:tsx evals/memory/run.ts [extract|recall] [--local]
// 前提:dao 已配 profile(/login 或 ~/.dao/config.json)。真实模型、非 CI。
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { streamChat } from "../../src/client/client.js";
import { loadEvalConfig } from "./lib/creds.js";
import { runExtractCase } from "./extract.js";
import { runRecallCase } from "./recall.js";
import { formatExtractReport, formatRecallReport } from "./report.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function listCases(kind: "extract" | "recall"): Promise<string[]> {
  const base = path.join(__dirname, "fixtures", kind);
  const names = await fs.readdir(base).catch(() => []);
  const dirs: string[] = [];
  for (const n of names) { const p = path.join(base, n); if ((await fs.stat(p)).isDirectory()) dirs.push(p); }
  return dirs;
}

async function main() {
  const args = process.argv.slice(2);
  const which = args.find((a) => a === "extract" || a === "recall");
  const cfg = await loadEvalConfig();
  const sc = streamChat as any;
  let report = "";
  if (!which || which === "extract") {
    const rows = [];
    for (const dir of await listCases("extract")) rows.push({ case: path.basename(dir), score: await runExtractCase(dir, sc, cfg) });
    report += formatExtractReport(rows) + "\n";
  }
  if (!which || which === "recall") {
    const rows = [];
    for (const dir of await listCases("recall")) rows.push({ case: path.basename(dir), score: await runRecallCase(dir, sc, cfg) });
    report += formatRecallReport(rows) + "\n";
  }
  await fs.writeFile(path.join(__dirname, "report.md"), report, "utf8");
  console.log(report);
}
main().catch((e) => { console.error(e); process.exit(1); });
```
> `--local` 的真实 session 接入(读 `~/DaoProject/*/.dao/sessions/*/events.jsonl`)在 README 记为后续增强;本任务先把 fixtures/ 跑通。`listCases` 跳过以 `_` 开头是可选的——保留 `_synthetic` 也跑,作冒烟。

`README.md`:写明用途、`tsx evals/memory/run.ts` 用法、前提(profile)、`EVAL_JUDGE_K`/`DEEPSEEK_MODEL` 环境、金标制备约定(Claude 起草+用户抽查)、CI 只跑纯单测、打分跑批离线。

- [ ] **Step 4: 跑绿** — `npx vitest run evals/memory/report.test.ts` → PASS;`npx tsc --noEmit -p tsconfig.json` → 干净;`npx vitest run` 全量绿

- [ ] **Step 5: 提交**
```bash
git add evals/memory/report.ts evals/memory/report.test.ts evals/memory/run.ts evals/memory/README.md
git commit -m "feat(eval): 报告格式化 + 跑批入口 run.ts + README"
```

---

## Task 10(controller,非子代理):真实金标制备 + 基线跑批

> 这是 controller + 用户协作任务,**不派 implementer 子代理**(需判断与用户抽查)。

- [ ] controller 从 `~/DaoProject/slide/.dao/sessions/20260629-144349-mxk0`、`bubble-machine/.../20260619-142614-m94s` 各取 `events.jsonl`,跑 `redactEvents` 脱敏 → 写 `fixtures/extract/<case>/conversation.jsonl`。
- [ ] controller 通读脱敏对话,起草 `gold.json`(mustExtract 标 type/scope、mustNot、profileFacts)。召回侧从对应 `.dao/memory` 取脱敏记忆做 `store/` + 起草 `context.json`(valueGold/relevanceGold)。
- [ ] **用户抽查** mustExtract / mustNot 两份清单,改完定稿、提交 fixture。
- [ ] 在有 profile 的机器跑 `tsx evals/memory/run.ts`,产 `report.md` 基线;把基线数字 + 暴露的弱点(尤其画像召回)写进会话结论。

---

## Self-Review

**1. Spec 覆盖**
- transcript 适配 → T2;脱敏 → T3;judge(三 rubric + K 次)→ T5;金标语义匹配靠 judge → T5/T7;提取双轨(gold+rubric)→ T7;召回 A 闸 + B 缺口 → T8;creds/profile → T6;报告 + 跑批 + --local 说明 → T9;金标制备「Claude 起草+用户抽查」→ T10;纯逻辑进 CI、打分离线 → 全程(单测 fake streamChat,run.ts 真实)。✓
- 非目标(不改记忆行为、CI 不跑打分、无 embedding)→ 计划未越界。✓

**2. Placeholder 扫描**:无 TBD;每个代码步给完整代码与具体命令;真实金标数据是 T10 的 controller 产物(数据非代码,不可能在计划里写死,已显式标为人审检查点)。✓

**3. 类型一致性**:`EvalConfig`/`ExtractGold`/`RecallContext`/`JudgeResult`(T1)贯穿 T5-T9;`ExtractScore`(T7)、`RecallScore`(T8)被 T9 report 消费;`reflect` 入参形状对齐 `src/index.ts:1074` 实际用法(`config:{baseUrl,apiKey}` + `model` + `messages` + `existing` + `today` + `fork`);`streamChat` 注入签名对齐 `src/client/client.ts`。✓

**已知待实现期核对点(非阻塞)**:
- `findSecrets` 返回元素是否为纯字符串(T3 redact 用 `.split(sec)`)——以 `src/permissions/secrets.ts` 实际签名为准,若为对象取其值字段。
- `selectForInjection` 的入参形状(`{mem, verdict}[]`)与返回——以 `src/memory/inject.ts` 实际为准(T8 已按探查结果写)。
- `parseMemoryFile` 若 T8 未直接用则删其 import,避免未用 import 触发 tsc/lint。
