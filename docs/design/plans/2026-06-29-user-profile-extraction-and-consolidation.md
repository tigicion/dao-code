# 用户画像提取强化 + 记忆合并 pass 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让自主反思器对照维度清单主动抽取通用用户画像,并新增会话启动期、三作用域、写回落地的记忆合并 pass。

**Architecture:** 提取侧改 `REFLECT_TAIL` prompt(加画像维度块 + 纪律,`source` 承载 user_stated/inferred);合并侧新建 `src/memory/consolidate.ts`(纯函数 parse/gate/apply + 一个 LLM runner),在 `index.ts` 启动期 GC 后对 user/knowledge/project 三作用域各跑一次 gated 合并,canonical upsert 写盘、被并源 supersede 软删。

**Tech Stack:** TypeScript(ESM,import 带 `.js` 后缀)、vitest、现有 `streamChat`/`store.ts`/`memory_audit.ts` 原语。

## Global Constraints

- 语言 TypeScript,源码 import 必须带 `.js` 后缀(ESM);注释用中文,匹配现有风格。
- 不增加 LLM 调用数到主回路:提取仍是 REFLECT_TAIL 一次;合并 pass 是启动期低频、三作用域各自 gated。
- 合并模型默认主模型:`process.env.DAO_CONSOLIDATE_MODEL || cfg.model`(dao-code 无单独便宜档,distill 本身就走主模型 v4 pro;provider 安全,不硬编码 deepseek-v4-flash)。
- 被并源一律 **supersede 软删**(`status: superseded` + `supersededBy`,`validUntil = today`),不硬删。
- git commit message 不加任何 AI 署名。
- 每个 Task 结束:`npx tsc --noEmit -p tsconfig.json` 干净 + 相关 vitest 绿。
- marker 文件用 epoch-ms 时间戳 + 节流比较,镜像 `src/agent/cleanup.ts:38` 的 `maybeCleanup` 写法。

---

### Task 1: 提取 prompt —— REFLECT_TAIL 画像维度块 + 纪律

**Files:**
- Modify: `src/agent/unified_reflect.ts`(`REFLECT_TAIL` 常量,~L8-30)
- Modify: `src/agent/reflect_prompts.test.ts`(新增断言)或 `src/agent/unified_reflect.test.ts`
- Test: `src/agent/unified_reflect.test.ts`

**Interfaces:**
- Consumes: 现有 `REFLECT_TAIL` 文本、`ReflectMem.source`(已是可选 string,直通)。
- Produces: 无新签名;约定 `source` 对画像类记忆取值 `"user_stated"` 或 `"inferred"`。

- [ ] **Step 1: Write the failing test**

在 `src/agent/unified_reflect.test.ts` 末尾追加:

```ts
import { REFLECT_TAIL } from "./unified_reflect.js";

describe("REFLECT_TAIL 通用画像维度块", () => {
  it("含五个画像维度关键词", () => {
    for (const kw of ["沟通偏好", "工作风格", "专业背景", "反复出现", "硬规矩"]) {
      expect(REFLECT_TAIL).toContain(kw);
    }
  });
  it("含 user_stated / inferred 来源区分与隐私红线", () => {
    expect(REFLECT_TAIL).toContain("user_stated");
    expect(REFLECT_TAIL).toContain("inferred");
    expect(REFLECT_TAIL).toContain("红线");
  });
  it("含『上抽』指令(项目事实抽象成人物画像)", () => {
    expect(REFLECT_TAIL).toContain("上抽");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/unified_reflect.test.ts -t "通用画像维度块"`
Expected: FAIL(REFLECT_TAIL 暂无这些词)

- [ ] **Step 3: 在 REFLECT_TAIL 的「二、记忆」段插入画像维度块**

在 `src/agent/unified_reflect.ts` 的 `REFLECT_TAIL` 里,`## 二、记忆` 标题之后、`按 5 type 归类` 之前,插入:

```
### 2a. 通用用户画像(最高价值,主动抽,别等人提醒)
对照下列维度,主动抽取【跨项目、跨会话都稳定】的人物画像(type=user;明确规矩 type=feedback):
- 沟通偏好:语言、详略、先结论后展开、能否接受直接反对、emoji/寒暄。
- 工作风格:全局优先 vs 细节优先、一次完整方案 vs 小步、重数据 vs 重直觉、容错度(先跑起来 vs 一次做对)。
- 专业背景:职业/角色、领域、资历(决定术语密度)。
- 反复出现的目标/项目:用户长期在做的事(如"持续给低龄儿童做 iPad 游戏")。最易混入临时状态,谨慎。
- 明确硬规矩:用户亲口立的规矩("别用 emoji""先讨论再动手")。
【纪律】
1. 稳定性测试:换个项目/话题这条还成立吗?不成立(如"现在在调一个 bug")不抽。
2. 上抽:把项目事实抽象成人物画像——不是记"这个滑梯游戏",是记"这个人持续做低龄儿童游戏、懂其认知边界"。
3. 来源区分,填进 source:user_stated(用户亲口立,confidence 可高)/ inferred(你从行为推断,单次信号 confidence 0.3-0.4,需多次出现才升)。
4. 红线:性格标签、情绪状态、政治/宗教/健康等敏感信息、无对话佐证的人口统计推测,一律不碰。
5. 每个画像维度只应有一条生效记忆:新证据若延伸/涵盖已有画像,设 mergeInto=该条 title 并入,不要另起一条。
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/unified_reflect.test.ts -t "通用画像维度块"`
Expected: PASS

- [ ] **Step 5: 回归 + 提交**

Run: `npx vitest run src/agent/ && npx tsc --noEmit -p tsconfig.json`
Expected: 全绿 + tsc 无输出

```bash
git add src/agent/unified_reflect.ts src/agent/unified_reflect.test.ts
git commit -m "feat(reflect): REFLECT_TAIL 增通用画像维度块+纪律(user_stated/inferred/上抽/红线)"
```

---

### Task 2: 合并 pass 纯函数 —— 类型 / 解析 / 闸门 / prompt

**Files:**
- Create: `src/memory/consolidate.ts`
- Test: `src/memory/consolidate.test.ts`

**Interfaces:**
- Consumes: `Memory`(`./types.js`)、`slug`(`./store.js`)。
- Produces:
  - `interface ConsolidationGroup { canonical: { title: string; text: string; type?: string; importance?: number; confidence?: number; source?: string }; supersede: string[]; reason: string }`
  - `interface ConsolidationPlan { groups: ConsolidationGroup[] }`
  - `parseConsolidationPlan(raw: string): ConsolidationPlan`
  - `type ConsolScope = "user" | "knowledge" | "project"`
  - `interface ConsolCfg { days: number; min: number; force: "aggressive" | "medium" | "conservative" }`
  - `consolidationCfg(scope: ConsolScope): ConsolCfg`
  - `shouldConsolidate(lastMs: number, liveCount: number, now: number, cfg: ConsolCfg): boolean`
  - `buildConsolidatePrompt(scope: ConsolScope, mems: { name: string; title?: string; text: string; type: string; source?: string }[]): string`

- [ ] **Step 1: Write the failing test**

`src/memory/consolidate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseConsolidationPlan, shouldConsolidate, consolidationCfg, buildConsolidatePrompt } from "./consolidate.js";

const DAY = 86_400_000;

describe("parseConsolidationPlan", () => {
  it("正常 JSON 解析 groups", () => {
    const raw = JSON.stringify({ groups: [{ canonical: { title: "T", text: "X" }, supersede: ["a", "b"], reason: "r" }] });
    const p = parseConsolidationPlan(raw);
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0]!.supersede).toEqual(["a", "b"]);
  });
  it("带围栏也能抽", () => {
    const raw = "好\n```json\n" + JSON.stringify({ groups: [] }) + "\n```";
    expect(parseConsolidationPlan(raw).groups).toEqual([]);
  });
  it("坏 JSON → 空计划(不抛)", () => {
    expect(parseConsolidationPlan("乱七八糟").groups).toEqual([]);
  });
  it("丢弃缺字段的坏 group(canonical 无 text / supersede 非数组)", () => {
    const raw = JSON.stringify({ groups: [
      { canonical: { title: "T" }, supersede: ["a"], reason: "r" },     // 无 text
      { canonical: { title: "T", text: "X" }, supersede: "a", reason: "r" }, // supersede 非数组
      { canonical: { title: "T", text: "X" }, supersede: ["a"], reason: "r" }, // 好
    ] });
    expect(parseConsolidationPlan(raw).groups).toHaveLength(1);
  });
});

describe("shouldConsolidate", () => {
  const cfg = consolidationCfg("user"); // days 3, min 12
  const now = 10 * DAY;
  it("未到天数 → false", () => {
    expect(shouldConsolidate(now - 1 * DAY, 100, now, cfg)).toBe(false);
  });
  it("到天数但条数不足 → false", () => {
    expect(shouldConsolidate(now - 5 * DAY, 5, now, cfg)).toBe(false);
  });
  it("到天数且条数够 → true", () => {
    expect(shouldConsolidate(now - 5 * DAY, 20, now, cfg)).toBe(true);
  });
  it("从未跑过(lastMs=0)且条数够 → true", () => {
    expect(shouldConsolidate(0, 20, now, cfg)).toBe(true);
  });
});

describe("consolidationCfg / buildConsolidatePrompt", () => {
  it("三作用域力度/阈值不同", () => {
    expect(consolidationCfg("user").force).toBe("aggressive");
    expect(consolidationCfg("knowledge").force).toBe("medium");
    expect(consolidationCfg("project").force).toBe("conservative");
    expect(consolidationCfg("project").min).toBeGreaterThan(consolidationCfg("user").min);
  });
  it("project prompt 强调保守、只并明确冗余", () => {
    const p = buildConsolidatePrompt("project", [{ name: "x", text: "t", type: "episodic" }]);
    expect(p).toContain("保守");
    expect(p).toContain("不跨 source");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/memory/consolidate.test.ts`
Expected: FAIL("Cannot find module './consolidate.js'")

- [ ] **Step 3: 实现 `src/memory/consolidate.ts`(纯函数部分)**

```ts
// 记忆合并 pass:对一个作用域的全部 live 记忆做一次推理重合并,清理跨会话累积的重叠/矛盾。
// 纯函数(parse/gate/prompt)与 LLM runner(见 consolidate())分离,便于测试。
import type { Memory } from "./types.js";

export interface ConsolidationGroup {
  canonical: { title: string; text: string; type?: string; importance?: number; confidence?: number; source?: string };
  supersede: string[]; // 被并掉的旧记忆 name
  reason: string;
}
export interface ConsolidationPlan { groups: ConsolidationGroup[] }

const EMPTY: ConsolidationPlan = { groups: [] };

function extractObject(s: string): Record<string, unknown> | null {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? (fence[1] ?? s) : s;
  const m = body.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { const v = JSON.parse(m[0]); return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; }
  catch { return null; }
}

function parseGroup(x: unknown): ConsolidationGroup | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const c = o.canonical;
  if (!c || typeof c !== "object") return null;
  const cc = c as Record<string, unknown>;
  const title = typeof cc.title === "string" ? cc.title.trim() : "";
  const text = typeof cc.text === "string" ? cc.text.trim() : "";
  if (!text) return null; // canonical 必须有正文
  if (!Array.isArray(o.supersede)) return null;
  const supersede = o.supersede.filter((s): s is string => typeof s === "string" && !!s.trim());
  const g: ConsolidationGroup = {
    canonical: { title, text },
    supersede,
    reason: typeof o.reason === "string" ? o.reason.trim() : "",
  };
  if (typeof cc.type === "string") g.canonical.type = cc.type;
  if (typeof cc.importance === "number") g.canonical.importance = cc.importance;
  if (typeof cc.confidence === "number") g.canonical.confidence = cc.confidence;
  if (typeof cc.source === "string" && cc.source.trim()) g.canonical.source = cc.source.trim();
  return g;
}

export function parseConsolidationPlan(raw: string): ConsolidationPlan {
  const obj = extractObject(raw);
  if (!obj || !Array.isArray(obj.groups)) return { ...EMPTY };
  return { groups: obj.groups.map(parseGroup).filter(Boolean) as ConsolidationGroup[] };
}

export type ConsolScope = "user" | "knowledge" | "project";
export interface ConsolCfg { days: number; min: number; force: "aggressive" | "medium" | "conservative" }

export function consolidationCfg(scope: ConsolScope): ConsolCfg {
  if (scope === "user") return { days: 3, min: 12, force: "aggressive" };
  if (scope === "knowledge") return { days: 3, min: 15, force: "medium" };
  return { days: 3, min: 20, force: "conservative" };
}

const DAY_MS = 86_400_000;
export function shouldConsolidate(lastMs: number, liveCount: number, now: number, cfg: ConsolCfg): boolean {
  if (liveCount < cfg.min) return false;
  return now - lastMs >= cfg.days * DAY_MS;
}

const FORCE_LINE: Record<ConsolCfg["force"], string> = {
  aggressive: "积极:同一画像维度的多条收敛成一条规范记忆。",
  medium: "中等:同一技术事实/知识点的重复条目去重合并。",
  conservative: "保守:只合并【明确冗余或直接矛盾】的条目(如两条讲同一件事的进度快照);异质事实一律保留,拿不准就不合并。",
};

export function buildConsolidatePrompt(
  scope: ConsolScope,
  mems: { name: string; title?: string; text: string; type: string; source?: string }[],
): string {
  const list = mems.map((m) => `- name=${m.name} | type=${m.type}${m.source ? " | source=" + m.source : ""} | ${m.title ?? ""}: ${m.text}`).join("\n");
  return `你在做记忆库的【合并整理】。下面是 ${scope} 作用域的全部生效记忆。找出重叠/冗余/矛盾的簇并合并。只输出一个 JSON 对象,无其它文字。

力度:${FORCE_LINE[consolidationCfg(scope).force]}
纪律:
- 不跨 source 合并(user_stated 与 inferred 永不混)。
- 每簇产出一条 canonical(合成后的规范全文,取最高 confidence;矛盾时偏向 user_stated 与更新者),并列出被它取代的旧记忆 name 到 supersede。
- 每簇必须给 reason。无可合并 → groups: []。
- 保守优先:漏合并的代价远小于错合并污染全局。

记忆清单:
${list}

输出(严格 JSON):
{"groups":[{"canonical":{"title":"…","text":"合成后的完整规范正文","type":"user","importance":8,"confidence":0.85,"source":"inferred"},"supersede":["旧name1","旧name2"],"reason":"二者都讲 X,canonical 已涵盖"}]}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/memory/consolidate.test.ts`
Expected: PASS(全部)

- [ ] **Step 5: Commit**

```bash
git add src/memory/consolidate.ts src/memory/consolidate.test.ts
git commit -m "feat(memory): 合并 pass 纯函数(parse/gate/scope cfg/prompt)"
```

---

### Task 3: 写回落地 —— applyConsolidationPlan

**Files:**
- Modify: `src/memory/consolidate.ts`(新增 `applyConsolidationPlan`)
- Modify: `src/memory/consolidate.test.ts`

**Interfaces:**
- Consumes: `upsertMemory`、`supersedeMemory`、`slug`(`./store.js`);`newMemory`(`./types.js`);`Memory`。
- Produces: `applyConsolidationPlan(dir: string, plan: ConsolidationPlan, existing: Memory[], today: string): Promise<{ merged: number; superseded: number }>`

- [ ] **Step 1: Write the failing test**

追加到 `src/memory/consolidate.test.ts`:

```ts
import { applyConsolidationPlan } from "./consolidate.js";
import { writeMemory, loadAllMemories } from "./store.js";
import { newMemory } from "./types.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "consol-"));

describe("applyConsolidationPlan 写回落地", () => {
  it("canonical 写盘 + 被并源 supersede,live 集只剩 canonical", async () => {
    const d = await tmp();
    await writeMemory(d, newMemory({ name: "家长", title: "为2岁孩子做游戏的家长", text: "持续做儿童游戏,懂认知边界", type: "user", today: "2026-06-07", importance: 8 }));
    await writeMemory(d, newMemory({ name: "swiftui-spritekit", title: "偏好 SwiftUI+SpriteKit 做儿童游戏", text: "用 SwiftUI+SpriteKit", type: "user", today: "2026-06-07", importance: 5 }));
    const existing = await loadAllMemories(d, d + "-x");
    const plan = { groups: [{
      canonical: { title: "为2岁孩子做游戏的家长", text: "持续做儿童游戏,懂认知边界;技术上用 SwiftUI+SpriteKit", type: "user", importance: 8, confidence: 0.85, source: "inferred" },
      supersede: ["swiftui-spritekit"],
      reason: "家长画像已涵盖技术偏好",
    }] };
    const r = await applyConsolidationPlan(d, plan, existing, "2026-06-29");
    expect(r).toEqual({ merged: 1, superseded: 1 });
    const live = await loadAllMemories(d, d + "-x");
    expect(live.map((m) => m.name).sort()).toEqual(["家长"]); // 只剩 canonical(slug(title)=家长 命中既有 name)
    expect(live[0]!.text).toContain("SwiftUI");
    const raw = await fs.readFile(path.join(d, "swiftui-spritekit.md"), "utf8");
    expect(raw).toMatch(/status: superseded/);
  });

  it("supersede 指向不存在的 name → 跳过不抛", async () => {
    const d = await tmp();
    const plan = { groups: [{ canonical: { title: "T", text: "X", type: "user" }, supersede: ["不存在"], reason: "r" }] };
    const r = await applyConsolidationPlan(d, plan, [], "2026-06-29");
    expect(r.merged).toBe(1);
    expect(r.superseded).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/memory/consolidate.test.ts -t "写回落地"`
Expected: FAIL("applyConsolidationPlan is not a function")

- [ ] **Step 3: 实现 applyConsolidationPlan**

在 `src/memory/consolidate.ts` 顶部补 import,并新增函数:

```ts
import { upsertMemory, supersedeMemory, slug } from "./store.js";
import { newMemory } from "./types.js";

// 写回落地:canonical upsert 写盘;被并源 supersede 软删(validUntil=today,GC 7 天宽限后清)。
// canonical 的 name 用 slug(title);若与某 supersede 项同名,跳过对它的 supersede(它就是 canonical 本体)。
export async function applyConsolidationPlan(
  dir: string,
  plan: ConsolidationPlan,
  existing: Memory[],
  today: string,
): Promise<{ merged: number; superseded: number }> {
  let merged = 0, superseded = 0;
  for (const g of plan.groups) {
    const cand = newMemory({
      name: slug(g.canonical.title || g.canonical.text),
      title: g.canonical.title,
      text: g.canonical.text,
      type: (g.canonical.type as Memory["type"]) || "user",
      today,
      importance: g.canonical.importance,
      confidence: g.canonical.confidence,
      source: g.canonical.source,
    });
    await upsertMemory(dir, cand, existing);
    merged++;
    for (const oldName of g.supersede) {
      if (oldName === cand.name) continue; // 别把 canonical 本体 supersede 掉
      const before = existing.find((m) => m.name === oldName);
      await supersedeMemory(dir, oldName, cand.name, today);
      if (before) superseded++;
    }
  }
  return { merged, superseded };
}
```

> 注:`supersedeMemory` 内部读不到文件会静默 return,故"不存在的 name"不抛;`superseded` 计数只统计 existing 里确实存在的,保证测试里 superseded=0。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/memory/consolidate.test.ts`
Expected: PASS(全部)

- [ ] **Step 5: Commit**

```bash
git add src/memory/consolidate.ts src/memory/consolidate.test.ts
git commit -m "feat(memory): 合并写回落地 applyConsolidationPlan(canonical upsert + 源 supersede)"
```

---

### Task 4: LLM runner —— consolidate()

**Files:**
- Modify: `src/memory/consolidate.ts`(新增 `consolidate`)
- Modify: `src/memory/consolidate.test.ts`

**Interfaces:**
- Consumes: `streamChat` 形态(参考 `unified_reflect.ts` 的 `ReflectInput.streamChat`)。
- Produces:
  - `interface ConsolidateInput { streamChat: (opts: any) => AsyncGenerator<any, any>; config: { baseUrl: string; apiKey: string }; model: string; scope: ConsolScope; mems: { name: string; title?: string; text: string; type: string; source?: string }[]; onUsage?: (u: unknown) => void }`
  - `consolidate(p: ConsolidateInput): Promise<ConsolidationPlan>`

- [ ] **Step 1: Write the failing test**

追加到 `src/memory/consolidate.test.ts`:

```ts
import { consolidate } from "./consolidate.js";

function stubStream(returnText: string) {
  return async function* () { yield { kind: "content", text: returnText }; return { content: returnText }; };
}

describe("consolidate LLM runner", () => {
  it("把 mems 发给模型并解析返回计划", async () => {
    let sentModel = "";
    const plan = await consolidate({
      streamChat: ((opts: any) => { sentModel = opts.model; return stubStream(JSON.stringify({ groups: [{ canonical: { title: "T", text: "X" }, supersede: ["a"], reason: "r" }] }))(); }) as any,
      config: { baseUrl: "u", apiKey: "k" }, model: "m-cheap", scope: "user",
      mems: [{ name: "a", text: "x", type: "user" }],
    });
    expect(sentModel).toBe("m-cheap");
    expect(plan.groups).toHaveLength(1);
  });
  it("模型返回乱码 → 空计划(不抛)", async () => {
    const plan = await consolidate({
      streamChat: (() => stubStream("乱码")()) as any,
      config: { baseUrl: "u", apiKey: "k" }, model: "m", scope: "project",
      mems: [{ name: "a", text: "x", type: "episodic" }],
    });
    expect(plan.groups).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/memory/consolidate.test.ts -t "LLM runner"`
Expected: FAIL("consolidate is not a function")

- [ ] **Step 3: 实现 consolidate()**

在 `src/memory/consolidate.ts` 新增(参考 `unified_reflect.ts:59-78` 的流式读取写法):

```ts
export interface ConsolidateInput {
  streamChat: (opts: any) => AsyncGenerator<any, any>;
  config: { baseUrl: string; apiKey: string };
  model: string;
  scope: ConsolScope;
  mems: { name: string; title?: string; text: string; type: string; source?: string }[];
  onUsage?: (u: unknown) => void;
}

export async function consolidate(p: ConsolidateInput): Promise<ConsolidationPlan> {
  const prompt = buildConsolidatePrompt(p.scope, p.mems);
  try {
    const gen = p.streamChat({
      baseUrl: p.config.baseUrl, apiKey: p.config.apiKey, model: p.model,
      messages: [{ role: "user", content: prompt }],
      extra: { thinking: { type: "disabled" }, temperature: 0 },
      ...(p.onUsage ? { onUsage: p.onUsage } : {}),
    });
    let out = ""; let r = await gen.next();
    while (!r.done) { if (r.value?.kind === "content") out += r.value.text; r = await gen.next(); }
    if (!out && typeof r.value?.content === "string") out = r.value.content;
    return parseConsolidationPlan(out);
  } catch {
    return { groups: [] }; // 合并失败绝不影响启动
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/memory/consolidate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/consolidate.ts src/memory/consolidate.test.ts
git commit -m "feat(memory): 合并 LLM runner consolidate()(流式读取+容错解析)"
```

---

### Task 5: 可观测 —— memory-trace 的 consolidated 事件

**Files:**
- Modify: `src/memory/memory_audit.ts`
- Modify: `src/memory/memory_audit.test.ts`

**Interfaces:**
- Consumes: 现有 `MemoryTraceEvent`、`MemoryAuditSink`、`createMemoryAuditSink`。
- Produces:
  - `MemoryTraceEvent` 新增 `| { kind: "consolidated"; ts: number; scope: string; groups: number; superseded: number; reasons: string[] }`
  - `MemoryAuditSink.consolidated(e: { scope: string; groups: number; superseded: number; reasons: string[] }): void`

- [ ] **Step 1: Write the failing test**

追加到 `src/memory/memory_audit.test.ts`:

```ts
it("consolidated 事件落行", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mem-c-"));
  const s = createMemoryAuditSink(dir, {} as NodeJS.ProcessEnv);
  s.consolidated({ scope: "user", groups: 2, superseded: 3, reasons: ["a", "b"] });
  const ev = read(dir).find((e: any) => e.kind === "consolidated") as any;
  expect(ev).toMatchObject({ scope: "user", groups: 2, superseded: 3 });
  expect(ev.reasons).toEqual(["a", "b"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/memory/memory_audit.test.ts -t "consolidated 事件"`
Expected: FAIL(`s.consolidated is not a function`)

- [ ] **Step 3: 加 consolidated 事件 + sink 方法**

在 `src/memory/memory_audit.ts`:

`MemoryTraceEvent` 联合类型末尾加:
```ts
  | { kind: "consolidated"; ts: number; scope: string; groups: number; superseded: number; reasons: string[] };
```
`MemoryAuditSink` 接口加:
```ts
  consolidated(e: { scope: string; groups: number; superseded: number; reasons: string[] }): void;
```
`NOOP` 加 `consolidated() {}`。
`createMemoryAuditSink` 的 return 对象加:
```ts
    consolidated: (e) => write({ kind: "consolidated", ts: Date.now(), ...e }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/memory/memory_audit.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/memory_audit.ts src/memory/memory_audit.test.ts
git commit -m "feat(audit): memory-trace 增 consolidated 事件(scope/groups/superseded/reasons)"
```

---

### Task 6: 编排 + 闸门 + marker —— maybeConsolidate

**Files:**
- Modify: `src/memory/consolidate.ts`(新增 `maybeConsolidate`)
- Modify: `src/memory/consolidate.test.ts`

**Interfaces:**
- Consumes: `loadAllMemories`(`./store.js`)、`consolidate`/`applyConsolidationPlan`/`shouldConsolidate`/`consolidationCfg`(本模块)。
- Produces:
  - `interface MaybeConsolidateDeps { dir: string; scope: ConsolScope; today: string; now: number; streamChat: ConsolidateInput["streamChat"]; config: { baseUrl: string; apiKey: string }; model: string; onAudit?: (e: { scope: string; groups: number; superseded: number; reasons: string[] }) => void; onUsage?: (u: unknown) => void }`
  - `maybeConsolidate(deps: MaybeConsolidateDeps): Promise<void>` —— gated:未到天数/条数则跳过;跑则 consolidate→apply→audit→写 marker。

- [ ] **Step 1: Write the failing test**

追加到 `src/memory/consolidate.test.ts`:

```ts
import { maybeConsolidate } from "./consolidate.js";

describe("maybeConsolidate 闸门 + marker", () => {
  it("条数不足 → 不调模型、不写 marker", async () => {
    const d = await tmp();
    await writeMemory(d, newMemory({ name: "a", title: "A", text: "x", type: "user", today: "2026-06-07" }));
    let called = false;
    await maybeConsolidate({
      dir: d, scope: "user", today: "2026-06-29", now: 30 * DAY,
      streamChat: (() => { called = true; return stubStream("{}")(); }) as any,
      config: { baseUrl: "u", apiKey: "k" }, model: "m",
    });
    expect(called).toBe(false);
    await expect(fs.readFile(path.join(d, ".last-consolidation"), "utf8")).rejects.toThrow();
  });

  it("达标 → 跑合并、落地、写 marker、回调 audit", async () => {
    const d = await tmp();
    for (let i = 0; i < 13; i++) await writeMemory(d, newMemory({ name: "m" + i, title: "T" + i, text: "t" + i, type: "user", today: "2026-06-07" }));
    const planJson = JSON.stringify({ groups: [{ canonical: { title: "T0", text: "merged", type: "user" }, supersede: ["m1"], reason: "r" }] });
    let audited: any = null;
    await maybeConsolidate({
      dir: d, scope: "user", today: "2026-06-29", now: 30 * DAY,
      streamChat: (() => stubStream(planJson)()) as any,
      config: { baseUrl: "u", apiKey: "k" }, model: "m",
      onAudit: (e) => { audited = e; },
    });
    expect(audited).toMatchObject({ scope: "user", groups: 1, superseded: 1 });
    const marker = await fs.readFile(path.join(d, ".last-consolidation"), "utf8");
    expect(Number(marker)).toBe(30 * DAY);
    const raw = await fs.readFile(path.join(d, "m1.md"), "utf8");
    expect(raw).toMatch(/status: superseded/);
  });

  it("marker 未过期 → 跳过", async () => {
    const d = await tmp();
    for (let i = 0; i < 13; i++) await writeMemory(d, newMemory({ name: "m" + i, title: "T" + i, text: "t" + i, type: "user", today: "2026-06-07" }));
    await fs.writeFile(path.join(d, ".last-consolidation"), String(30 * DAY - 1 * DAY), "utf8"); // 1 天前
    let called = false;
    await maybeConsolidate({
      dir: d, scope: "user", today: "2026-06-29", now: 30 * DAY,
      streamChat: (() => { called = true; return stubStream("{}")(); }) as any,
      config: { baseUrl: "u", apiKey: "k" }, model: "m",
    });
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/memory/consolidate.test.ts -t "闸门"`
Expected: FAIL("maybeConsolidate is not a function")

- [ ] **Step 3: 实现 maybeConsolidate**

在 `src/memory/consolidate.ts` 补 import 与函数:

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadAllMemories } from "./store.js";

export interface MaybeConsolidateDeps {
  dir: string;
  scope: ConsolScope;
  today: string;
  now: number;
  streamChat: ConsolidateInput["streamChat"];
  config: { baseUrl: string; apiKey: string };
  model: string;
  onAudit?: (e: { scope: string; groups: number; superseded: number; reasons: string[] }) => void;
  onUsage?: (u: unknown) => void;
}

// 启动期 gated 合并:仅该作用域 dir;未达天数/条数则跳过。失败绝不影响启动。
export async function maybeConsolidate(deps: MaybeConsolidateDeps): Promise<void> {
  const cfg = consolidationCfg(deps.scope);
  const marker = path.join(deps.dir, ".last-consolidation");
  try {
    const existing = await loadAllMemories(deps.dir, deps.dir + "-none-other"); // 只读本 dir 的 active
    if (existing.length < cfg.min) return;
    const lastMs = Number(await fs.readFile(marker, "utf8").catch(() => "0"));
    if (!shouldConsolidate(lastMs, existing.length, deps.now, cfg)) return;

    const mems = existing.map((m) => ({ name: m.name, title: m.title, text: m.text, type: m.type, source: m.source }));
    const plan = await consolidate({ streamChat: deps.streamChat, config: deps.config, model: deps.model, scope: deps.scope, mems, ...(deps.onUsage ? { onUsage: deps.onUsage } : {}) });

    const r = await applyConsolidationPlan(deps.dir, plan, existing, deps.today);
    deps.onAudit?.({ scope: deps.scope, groups: r.merged, superseded: r.superseded, reasons: plan.groups.map((g) => g.reason) });

    await fs.mkdir(deps.dir, { recursive: true });
    await fs.writeFile(marker, String(deps.now), "utf8");
  } catch { /* 合并失败不影响启动 */ }
}
```

> 注:`loadAllMemories(dir, dir+"-none-other")` 第二个不存在目录是为复用其"只返回 active"的过滤;只读单 dir 即满足"项目级只合当前项目目录"。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/memory/consolidate.test.ts`
Expected: PASS(全部)

- [ ] **Step 5: Commit**

```bash
git add src/memory/consolidate.ts src/memory/consolidate.test.ts
git commit -m "feat(memory): maybeConsolidate 编排(闸门+marker+落地+audit 回调)"
```

---

### Task 7: 接线到启动期 —— index.ts 三作用域调用

**Files:**
- Modify: `src/index.ts`(~L449,`gcMemories` 之后、`loadAllMemories` 之前)

**Interfaces:**
- Consumes: `maybeConsolidate`(`./memory/consolidate.js`)、现有 `streamChat`、`cfg`、`memoryAudit`、`projectMemoryDir`/`userMemoryDir`/`knowledgeMemoryDir`、`today`。

- [ ] **Step 1: 加 import**

`src/index.ts` 顶部 memory imports 处加:
```ts
import { maybeConsolidate } from "./memory/consolidate.js";
```

- [ ] **Step 2: 在 GC 后插入三作用域合并**

把 `src/index.ts` ~L447-449 的三行 gc 之后、`const memories = await loadAllMemories(...)` 之前插入:

```ts
  // 启动期合并 pass:GC 后、注入算定前。三作用域各自 gated(天数+条数),失败不影响启动。
  if (process.env.DAO_NO_MEMORY !== "1" && !argvPrompt) {
    const consolModel = process.env.DAO_CONSOLIDATE_MODEL || cfg.model;
    const now = Date.now();
    const common = { today, now, streamChat, config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey }, model: consolModel,
      onAudit: (e: { scope: string; groups: number; superseded: number; reasons: string[] }) => memoryAudit.consolidated(e) };
    await maybeConsolidate({ ...common, dir: userMemoryDir, scope: "user" });
    await maybeConsolidate({ ...common, dir: knowledgeMemoryDir, scope: "knowledge" });
    await maybeConsolidate({ ...common, dir: projectMemoryDir, scope: "project" });
  }
```

> 检查:`argvPrompt`、`streamChat`、`memoryAudit`、`cfg` 在该作用域是否已声明且在此行可见。`memoryAudit` 初值在 L679,若此处(L450 附近)早于 `memoryAudit` 赋值,则改用 `memoryAudit?.consolidated?.(e)` 或把合并调用挪到 `memoryAudit` 就绪后但仍在 `loadAllMemories` 之前。实现时以实际声明位置为准,保证"在注入算定前"且"audit sink 已就绪"。

- [ ] **Step 3: 校验编译 + 全量测试**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: tsc 无输出;全部测试绿。

- [ ] **Step 4: 手动冒烟(可选但建议)**

构造一个 ≥12 条 user 记忆、`.last-consolidation` 不存在的临时 home,设 `DAO_CONSOLIDATE_MODEL` 指向可用模型,启动一次,确认:`~/.dao/memory` 出现合并、`.last-consolidation` 写入、`memory-trace.jsonl` 有 `consolidated` 行。

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(memory): 启动期接入三作用域合并 pass(user/knowledge/project)"
```

---

## Self-Review

**Spec coverage:**
- 组件一(画像维度块 + 纪律 + user_stated/inferred) → Task 1 ✓
- 组件二(维度去重经 mergeInto) → Task 1 纪律第 5 条(mergeInto 收敛)+ 已有 `dedupKey`/`upsertMemory`(上一轮)✓
- 组件三(三作用域、闸门、写回落地、trace、启动期时机) → Task 2-7 ✓
- 写回落地(canonical upsert + 源 supersede 软删) → Task 3 ✓
- 三作用域力度/阈值差异 → Task 2 `consolidationCfg` + `buildConsolidatePrompt` ✓
- 可观测 trace → Task 5 ✓

**Placeholder scan:** 无 TBD/TODO;每个 code step 给了完整代码。Task 7 Step 2 留了一处"声明位置以实际为准"的检查说明——这是真实的接线核对项,非占位(给了两种兜底写法)。

**Type consistency:** `ConsolidationPlan`/`ConsolidationGroup`/`ConsolScope`/`ConsolCfg` 跨 Task 2-6 一致;`maybeConsolidate` 的 `onAudit` 签名与 Task 5 的 `consolidated` sink 入参一致(`{scope,groups,superseded,reasons}`);`applyConsolidationPlan` 返回 `{merged,superseded}` 与 Task 6 调用一致。

## 备注:与上一轮已落代码的衔接

上一轮(分支 `fix/memory-reflect-challenge-audit`)已落:`dedupKey`(slug(title) 去重 + 残片清理)、`deleteMemory`、reflect `note` trace。本计划的组件二直接复用 `dedupKey`/`mergeInto`/`upsertMemory`,无需重复实现。
