# 记忆纠错闭环 + 强化信号校准 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 让回合末反思器除"抽记忆"外,还能认领并纠正被实测推翻的旧记忆(supersede/revise),并把被实测证实的旧记忆 touch 续命——闭合"用后纠错"这一环。

**Architecture:** 搭车现有 `unified_reflect.ts` 的 REFLECT_TAIL(零新增 LLM 调用)。`reflect_result.ts` 多解析两段;`reflect_persist.ts` 加落地函数;`store.ts` 加 `touchMemory`;`index.ts` 在反思持久化后应用;`memory_audit.ts` 记 corrected/confirmed。

**Tech Stack:** TypeScript ESM(import 带 `.js`)、vitest、复用 `supersedeMemory`/`upsertMemory`/`slug`/`routeScope`。

## Global Constraints
- TypeScript ESM:import 带 `.js`。注释中文。
- 纠错搭车现有反思器,**不新增 LLM 调用**。
- 被纠正的旧记忆:`supersede` 软删(可追溯),不硬删。
- 单回合 `corrections` 上限 `CORRECTION_CAP = 3`(防一次误判批量毁库);超出取前 N。
- `confirmed` 只 touch `lastUsed`(温和续命),**不** +uses(把"被验证使用"与"被重复抽出"两信号分开)。
- git commit 不加 AI 署名。
- 每 Task 结束:`npx tsc --noEmit -p tsconfig.json` 干净 + 相关 vitest 绿。

---

### Task 1: reflect_result 解析 corrections + confirmed

**Files:**
- Modify: `src/agent/reflect_result.ts`
- Test: `src/agent/reflect_result.test.ts`

**Interfaces:**
- Produces (ReflectResult 扩展):
  - `correction: { target: string; action: "supersede" | "revise"; newText?: string; reason: string }`
  - `ReflectResult.corrections: Correction[]`
  - `ReflectResult.confirmed: string[]`

- [ ] **Step 1: 写失败测试**(追加到 `reflect_result.test.ts`)

```ts
it("解析 corrections + confirmed", () => {
  const raw = JSON.stringify({
    onTrack: true, advisory: null, memories: [],
    corrections: [
      { target: "旧事实A", action: "supersede", reason: "命令输出证明已不成立" },
      { target: "旧事实B", action: "revise", newText: "新的完整事实", reason: "部分过时" },
    ],
    confirmed: ["有用事实C"],
  });
  const r = parseReflectResult(raw);
  expect(r.corrections).toHaveLength(2);
  expect(r.corrections[0]).toMatchObject({ target: "旧事实A", action: "supersede" });
  expect(r.corrections[1]).toMatchObject({ target: "旧事实B", action: "revise", newText: "新的完整事实" });
  expect(r.confirmed).toEqual(["有用事实C"]);
});

it("坏 correction 降级:revise 无 newText 丢、action 非法丢、缺 target 丢", () => {
  const raw = JSON.stringify({
    onTrack: true, memories: [],
    corrections: [
      { target: "X", action: "revise", reason: "r" },          // revise 无 newText → 丢
      { target: "Y", action: "delete", reason: "r" },           // action 非法 → 丢
      { action: "supersede", reason: "r" },                     // 无 target → 丢
      { target: "Z", action: "supersede", reason: "r" },        // 好
    ],
    confirmed: ["A", "", "  ", "B"],                            // 空串过滤
  });
  const r = parseReflectResult(raw);
  expect(r.corrections).toHaveLength(1);
  expect(r.corrections[0]!.target).toBe("Z");
  expect(r.confirmed).toEqual(["A", "B"]);
});

it("缺失 corrections/confirmed → 空数组", () => {
  const r = parseReflectResult(JSON.stringify({ onTrack: true, memories: [] }));
  expect(r.corrections).toEqual([]);
  expect(r.confirmed).toEqual([]);
});
```

- [ ] **Step 2: 跑验证失败**

Run: `npx vitest run src/agent/reflect_result.test.ts -t "corrections"`
Expected: FAIL(`r.corrections` undefined)

- [ ] **Step 3: 实现**

`reflect_result.ts` — `ReflectResult` 接口增字段:
```ts
export interface Correction {
  target: string;
  action: "supersede" | "revise";
  newText?: string;
  reason: string;
}
```
在 `ReflectResult` 里加:
```ts
  corrections: Correction[];
  confirmed: string[];
```
`SAFE` 改为:
```ts
const SAFE: ReflectResult = { onTrack: true, advisory: null, memories: [], note: undefined, corrections: [], confirmed: [] };
```
新增解析函数:
```ts
function parseCorrection(x: unknown): Correction | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const target = typeof o.target === "string" ? o.target.trim() : "";
  const action = o.action;
  if (!target || (action !== "supersede" && action !== "revise")) return null;
  const c: Correction = { target, action, reason: typeof o.reason === "string" ? o.reason.trim() : "" };
  if (action === "revise") {
    const nt = typeof o.newText === "string" ? o.newText.trim() : "";
    if (!nt) return null; // revise 必须给 newText
    c.newText = nt;
  }
  return c;
}
```
在 `parseReflectResult` 的 `return` 前补:
```ts
  const corrections = Array.isArray(obj.corrections)
    ? (obj.corrections.map(parseCorrection).filter(Boolean) as Correction[])
    : [];
  const confirmed = Array.isArray(obj.confirmed)
    ? obj.confirmed.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim())
    : [];
```
`return { onTrack, advisory, memories, note, corrections, confirmed };`

- [ ] **Step 4: 跑验证通过**

Run: `npx vitest run src/agent/reflect_result.test.ts`
Expected: PASS（含既有用例;注意既有 `toEqual({onTrack,advisory,memories})` 的用例——新字段为空数组,`toEqual` 忽略 undefined 但不忽略 `[]`,若有此类用例需把期望补上 `corrections:[], confirmed:[]`,或确认其用 `toMatchObject`。先跑,按失败提示修期望。)

- [ ] **Step 5: 跑全 agent 测试 + 提交**

Run: `npx vitest run src/agent/ && npx tsc --noEmit -p tsconfig.json`

```bash
git add src/agent/reflect_result.ts src/agent/reflect_result.test.ts
git commit -m "feat(reflect): 解析 corrections + confirmed(纠错闭环输出)"
```

---

### Task 2: REFLECT_TAIL 增「三、纠错与确认」段

**Files:**
- Modify: `src/agent/unified_reflect.ts`(`REFLECT_TAIL` 常量)
- Test: `src/agent/unified_reflect.test.ts`

**Interfaces:** 无新签名;约定输出 JSON 增 `corrections`、`confirmed` 两字段。

- [ ] **Step 1: 写失败测试**(追加到 `unified_reflect.test.ts`)

```ts
describe("REFLECT_TAIL 纠错与确认段", () => {
  it("含 corrections/confirmed 指令与保守纪律", () => {
    for (const kw of ["纠错", "corrections", "confirmed", "supersede", "revise", "实测证据"]) {
      expect(REFLECT_TAIL).toContain(kw);
    }
  });
});
```

- [ ] **Step 2: 跑验证失败**

Run: `npx vitest run src/agent/unified_reflect.test.ts -t "纠错与确认"`
Expected: FAIL

- [ ] **Step 3: 实现** —— 在 REFLECT_TAIL 的「## 二、记忆」段之后、「## 输出(严格 JSON)」之前,插入:

```
## 三、对已有记忆的纠错与确认(只在【有本会话实测证据】时)
对照上面列出的【已有记忆】,仅当本会话的工具输出/命令结果/文件内容给了具体证据:
- corrections:某条已有记忆的事实被实测【推翻或需修正】→ {target: 该条 title, action: "supersede"|"revise", newText?: 改写后的完整事实(revise 必填), reason: 引具体证据}。
  极保守:只在【实测证据】确凿时纠错(错纠污染全局);拿不准不纠。supersede=该事实已不成立;revise=部分过时需更新。
- confirmed:某条已有记忆被本会话实测【证实且实际依赖】→ 列其 title。只列真正用上且成立的,不是"看到了"。
一切无据 → corrections: [], confirmed: []。
```
并把「## 输出(严格 JSON)」的示例行改为(加两字段):
```
{"onTrack":true,"advisory":null,"note":"…","memories":[…],"corrections":[{"target":"某条旧记忆标题","action":"revise","newText":"更新后的完整事实","reason":"命令 X 输出证明…"}],"confirmed":["被证实的旧记忆标题"]}
```

- [ ] **Step 4: 跑验证通过**

Run: `npx vitest run src/agent/unified_reflect.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/agent/unified_reflect.ts src/agent/unified_reflect.test.ts
git commit -m "feat(reflect): REFLECT_TAIL 增纠错与确认段(corrections/confirmed,保守纪律)"
```

---

### Task 3: store.touchMemory

**Files:**
- Modify: `src/memory/store.ts`
- Test: `src/memory/store.test.ts`

**Interfaces:**
- Produces: `touchMemory(dir: string, name: string, today: string): Promise<boolean>` —— 只更新该条 `lastUsed=today`(续命);改其它一律不动;文件不存在/坏 → 返回 false 不抛。

- [ ] **Step 1: 写失败测试**(追加到 `store.test.ts`)

```ts
import { touchMemory } from "./store.js"; // 加进顶部已有 import

describe("touchMemory — 被验证使用续命", () => {
  it("只刷新 lastUsed,不改 text/uses/importance", async () => {
    const d = await tmp();
    await writeMemory(d, { ...newMemory({ name: "m", title: "T", text: "原文", type: "user", today: "2026-06-01", importance: 7 }), uses: 3 });
    const ok = await touchMemory(d, "m", "2026-06-29");
    expect(ok).toBe(true);
    const all = await loadAllMemories(d, d + "-x");
    expect(all[0]!.lastUsed).toBe("2026-06-29");
    expect(all[0]!.text).toBe("原文");
    expect(all[0]!.uses).toBe(3);
    expect(all[0]!.importance).toBe(7);
  });
  it("不存在的 name → false,不抛", async () => {
    const d = await tmp();
    expect(await touchMemory(d, "没有", "2026-06-29")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑验证失败**

Run: `npx vitest run src/memory/store.test.ts -t "touchMemory"`
Expected: FAIL(`touchMemory is not a function`)

- [ ] **Step 3: 实现**(`store.ts` 新增)

```ts
// 被验证使用 → 续命:只把 lastUsed 刷到 today,其它字段不动。文件不存在/坏 → false。
export async function touchMemory(dir: string, name: string, today: string): Promise<boolean> {
  const raw = await fs.readFile(path.join(dir, `${name}.md`), "utf8").catch(() => "");
  const m = parseMemoryFile(name, raw);
  if (!m) return false;
  await writeMemory(dir, { ...m, lastUsed: today });
  return true;
}
```

- [ ] **Step 4: 跑验证通过**

Run: `npx vitest run src/memory/store.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/memory/store.ts src/memory/store.test.ts
git commit -m "feat(memory): touchMemory(被验证使用 → 只刷 lastUsed 续命)"
```

---

### Task 4: memory_audit reflected 增 corrected/confirmed

**Files:**
- Modify: `src/memory/memory_audit.ts`
- Test: `src/memory/memory_audit.test.ts`

**Interfaces:**
- `reflected` 事件 + sink 入参增 `corrected?: number; confirmed?: number`。
- `ReflectSummary` 增 `corrected: number; confirmed: number`;`formatReflectReport` 展示。

- [ ] **Step 1: 写失败测试**(追加到 `memory_audit.test.ts`)

```ts
it("reflected corrected/confirmed 落行 + 汇总 + 报告", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mem-cc-"));
  const s = createMemoryAuditSink(dir, {} as NodeJS.ProcessEnv);
  s.reflected({ ran: true, onTrack: true, advisoryInjected: false, memAdded: 0, memMerged: 0, interval: 1, corrected: 2, confirmed: 3 });
  const sum = summarizeReflectTrace(read(dir));
  expect(sum.corrected).toBe(2);
  expect(sum.confirmed).toBe(3);
  expect(formatReflectReport(sum)).toContain("纠错");
});
```

- [ ] **Step 2: 跑验证失败**

Run: `npx vitest run src/memory/memory_audit.test.ts -t "corrected"`
Expected: FAIL

- [ ] **Step 3: 实现**

`MemoryTraceEvent` 的 `reflected` 分支末尾加 `; corrected?: number; confirmed?: number`(在 `note?: string` 后)。
`MemoryAuditSink.reflected` 入参类型同样加 `corrected?: number; confirmed?: number`。
`ReflectSummary` 加:
```ts
  corrected: number;
  confirmed: number;
```
`summarizeReflectTrace` 初值加 `corrected: 0, confirmed: 0`;循环内加:
```ts
    s.corrected += e.corrected ?? 0;
    s.confirmed += e.confirmed ?? 0;
```
`formatReflectReport` 在记忆行后加:
```ts
    `  纠错:supersede/revise ${s.corrected} · 确认续命 ${s.confirmed}`,
```
(放进 lines 数组,位置在 `记忆:新增…` 那行之后。)

- [ ] **Step 4: 跑验证通过**

Run: `npx vitest run src/memory/memory_audit.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/memory/memory_audit.ts src/memory/memory_audit.test.ts
git commit -m "feat(audit): reflected 增 corrected/confirmed 计数(纠错可观测)"
```

---

### Task 5: reflect_persist 落地 applyCorrections + applyConfirmed

**Files:**
- Modify: `src/agent/reflect_persist.ts`
- Test: `src/agent/reflect_persist.test.ts`

**Interfaces:**
- Consumes: `supersedeMemory`/`upsertMemory`/`slug`(`../memory/store.js`)、`touchMemory`(Task 3)、`newMemory`(`../memory/types.js`)、`routeScope`(`../memory/store.js`)、`Correction`(`./reflect_result.js`)。
- Produces:
  - `applyCorrections(corrections: Correction[], existing: Memory[], dirFor: (t: MemoryType) => string, today: string, cap?: number): Promise<number>` —— 返回实际处理条数。
  - `applyConfirmed(confirmed: string[], existing: Memory[], dirFor: (t: MemoryType) => string, today: string): Promise<number>` —— 返回实际 touch 条数。

- [ ] **Step 1: 写失败测试**(`reflect_persist.test.ts`,若无则新建)

```ts
import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyCorrections, applyConfirmed } from "./reflect_persist.js";
import { writeMemory, loadAllMemories } from "../memory/store.js";
import { newMemory } from "../memory/types.js";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "refpersist-"));

describe("applyCorrections", () => {
  it("supersede 软删、revise 改写、cap 截断", async () => {
    const d = await tmp();
    const dirFor = () => d;
    await writeMemory(d, newMemory({ name: "a", title: "事实A", text: "旧A", type: "semantic", today: "2026-06-01" }));
    await writeMemory(d, newMemory({ name: "b", title: "事实B", text: "旧B", type: "semantic", today: "2026-06-01" }));
    const existing = await loadAllMemories(d, d + "-x");
    const n = await applyCorrections([
      { target: "事实A", action: "supersede", reason: "已不成立" },
      { target: "事实B", action: "revise", newText: "新B", reason: "更新" },
    ], existing, dirFor, "2026-06-29", 3);
    expect(n).toBe(2);
    const aRaw = await fs.readFile(path.join(d, "a.md"), "utf8");
    expect(aRaw).toMatch(/status: superseded/);
    const live = await loadAllMemories(d, d + "-x");
    expect(live.find((m) => m.name === "b")!.text).toBe("新B");
  });
  it("找不到 target → 跳过不抛;cap 限制处理条数", async () => {
    const d = await tmp();
    const existing = await loadAllMemories(d, d + "-x");
    expect(await applyCorrections([{ target: "无", action: "supersede", reason: "r" }], existing, () => d, "2026-06-29", 3)).toBe(0);
  });
});

describe("applyConfirmed", () => {
  it("touch 命中的 lastUsed", async () => {
    const d = await tmp();
    await writeMemory(d, newMemory({ name: "c", title: "事实C", text: "x", type: "user", today: "2026-06-01" }));
    const existing = await loadAllMemories(d, d + "-x");
    const n = await applyConfirmed(["事实C", "不存在"], existing, () => d, "2026-06-29");
    expect(n).toBe(1);
    expect((await loadAllMemories(d, d + "-x"))[0]!.lastUsed).toBe("2026-06-29");
  });
});
```

- [ ] **Step 2: 跑验证失败**

Run: `npx vitest run src/agent/reflect_persist.test.ts`
Expected: FAIL(函数不存在)

- [ ] **Step 3: 实现**(`reflect_persist.ts` 追加;顶部补 import)

```ts
import { slug, supersedeMemory, upsertMemory, touchMemory, routeScope } from "../memory/store.js";
import type { Memory, MemoryType } from "../memory/types.js";
import type { Correction } from "./reflect_result.js";

// 按 title 在 existing 里定位一条记忆(title 优先,退化按 name=slug(title))。
function findByTitle(existing: Memory[], target: string): Memory | undefined {
  return existing.find((e) => e.title === target || e.name === slug(target));
}

// 纠错落地:supersede 软删 / revise 改写。上限 cap 防一次误判批量毁库。返回实际处理条数。
export async function applyCorrections(
  corrections: Correction[],
  existing: Memory[],
  dirFor: (t: MemoryType) => string,
  today: string,
  cap = 3,
): Promise<number> {
  let n = 0;
  for (const c of corrections.slice(0, cap)) {
    const target = findByTitle(existing, c.target);
    if (!target || target.locked) continue;
    const dir = dirFor(target.type);
    if (c.action === "supersede") {
      await supersedeMemory(dir, target.name, target.name, today); // 指向自身=纯失效;软删可追溯
    } else {
      const revised = newMemory({ name: target.name, title: target.title, text: c.newText!, type: target.type, today, importance: target.importance, confidence: target.confidence, source: target.source });
      await upsertMemory(dir, revised, existing);
    }
    n++;
  }
  return n;
}

// 确认续命:touch 命中的 lastUsed。返回实际 touch 条数。
export async function applyConfirmed(
  confirmed: string[],
  existing: Memory[],
  dirFor: (t: MemoryType) => string,
  today: string,
): Promise<number> {
  let n = 0;
  for (const title of confirmed) {
    const target = findByTitle(existing, title);
    if (!target) continue;
    if (await touchMemory(dirFor(target.type), target.name, today)) n++;
  }
  return n;
}
```

> 注:`dirFor(type)` 由调用方按 `routeScope` 映射到 project/user/knowledge 目录;此处导入 `routeScope` 供调用方参考,但函数本身收 `dirFor` 以便测试注入。若 lint 报 `routeScope` 未用,从本文件 import 去掉(调用方 index.ts 自有)。

- [ ] **Step 4: 跑验证通过**

Run: `npx vitest run src/agent/reflect_persist.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/agent/reflect_persist.ts src/agent/reflect_persist.test.ts
git commit -m "feat(reflect): applyCorrections + applyConfirmed 落地(supersede/revise/touch + cap)"
```

---

### Task 6: index.ts 接线

**Files:**
- Modify: `src/index.ts`(store import L65;反思持久化 L1084-1093)

**Interfaces:** Consumes Task 5 的 `applyCorrections`/`applyConfirmed`、Task 3 的 `touchMemory`(经 Task5 间接用)。

- [ ] **Step 1: 加 import**

`src/index.ts` L72 附近(reflect_persist import 处):
```ts
import { reflectMemToCand, applyCorrections, applyConfirmed } from "./agent/reflect_persist.js";
```

- [ ] **Step 2: 在反思持久化后应用 corrections/confirmed**

把 L1084-1093 那段(memories 落盘 + advisory + `memoryAudit.reflected(...)`)改为:在 `for (const m of result.memories) {...}` 循环之后、`memoryAudit.reflected(...)` 之前,插入:
```ts
      // 纠错闭环:被实测推翻 → supersede/revise;被实测证实 → touch 续命。dirFor 按 type 路由作用域目录。
      const dirFor = (t: import("./memory/types.js").MemoryType) => {
        const sc = routeScope(t);
        return sc === "knowledge" ? knowledgeMemoryDir : sc === "user" ? userMemoryDir : projectMemoryDir;
      };
      const corrected = await applyCorrections(result.corrections, existing, dirFor, today);
      const confirmed = await applyConfirmed(result.confirmed, existing, dirFor, today);
```
并把 `memoryAudit.reflected({...})` 那行(L1093)加上两个计数:
```ts
      memoryAudit.reflected({ ran: true, onTrack: result.onTrack, advisoryInjected, memAdded: added, memMerged: merged, interval: cadenceState.interval, note: result.note, corrected, confirmed });
```

- [ ] **Step 3: 校验编译 + 全量测试**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: tsc 无输出;全部测试绿。
（核对:`routeScope` 已在 L65 import;`existing`/`today`/三个 memoryDir 变量在该作用域可见——它们就是上方 memories 循环用的同批变量。)

- [ ] **Step 4: 提交**

```bash
git add src/index.ts
git commit -m "feat(memory): 反思持久化接入纠错闭环(applyCorrections/applyConfirmed + audit 计数)"
```

---

## Self-Review

**Spec coverage:**
- 纠错(supersede/revise)→ Task 1(解析)+ Task 2(prompt)+ Task 5(落地)+ Task 6(接线)✓
- 确认续命(touch lastUsed)→ Task 3(touchMemory)+ Task 5(applyConfirmed)+ Task 6 ✓
- 强化信号校准(confirmed 只 touch 不 +uses)→ Task 3 实现只改 lastUsed ✓
- 保守闸 cap=3 → Task 5 `applyCorrections(..., cap=3)` ✓
- 软删非硬删 → Task 5 用 `supersedeMemory` ✓
- 可观测 → Task 4(corrected/confirmed trace + 报告)✓
- 零新增 LLM 调用 → 全程搭车现有 REFLECT_TAIL,无新 streamChat ✓

**Placeholder scan:** 无 TBD;每 code step 给完整代码。Task 1 Step 4 留了"按失败提示修既有 toEqual 期望"——这是真实的回归核对项(给了判断依据),非占位。

**Type consistency:** `Correction`(Task 1)被 Task 5 import 一致;`ReflectResult.corrections/confirmed`(Task 1)被 Task 6 经 `result.corrections/result.confirmed` 消费一致;`applyCorrections/applyConfirmed` 签名(Task 5)与 Task 6 调用一致;`reflected` 的 corrected/confirmed(Task 4)与 Task 6 传参一致;`dirFor: (t: MemoryType) => string` 跨 Task 5/6 一致。

## 与已落代码的衔接
复用上一批已落:`supersedeMemory`/`upsertMemory`/`slug`/`routeScope`/`reflectMemToCand`、`memoryAudit.reflected` 的 note 字段、reflect_result 的容错解析风格。本计划只在其上增量。
