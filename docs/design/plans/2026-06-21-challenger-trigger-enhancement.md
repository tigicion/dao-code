# 挑战者触发场景完善 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让挑战者在两个被实测证实的盲点也能触发——(路径②)agent 乱改文件但仍失败的"假进展",(路径①)用户反复申诉同一问题。

**Architecture:** 路径②改 `assessTurn` 一处布尔(失败即卡,不再被"改了文件"赦免)。路径①新增纯函数相似度门 + 异步挑战者控制器:用户消息入口比对历史、命中才 fork 挑战者(不阻塞主流程),结论经 `runTurn` 新增的 `drainAdvisories` 回合边界注入为 system advisory。复用现有 `reflect()`(pro fork + 前缀缓存)与 `textSimilarity`。

**Tech Stack:** TypeScript (ESM, NodeNext)、Vitest、现有 `src/text/similarity.ts` / `src/agent/reflect_prompts.ts` / `src/agent/loop.ts` / `src/index.ts`。

## Global Constraints

- 不引入任何第三方依赖,只复用现有模块。
- 一次性 / eval(`argvPrompt` 路径)**不接**路径①,延续现状(测量干净)。
- 缓存不变式:挑战者 fork 只在用户消息入口一次性快照 `[...session.messages]`;advisory 只经回合边界注入,不在回合中途改旧消息。
- 注释用中文,与现有代码风格一致。
- 每个任务结束跑 `npx vitest run <相关测试文件>`,绿了再 commit;全部完成跑一次 `npx vitest run` + `npx tsc --noEmit`。

---

### Task 1: 相似度门纯函数 `isRepeatComplaint`

**Files:**
- Create: `src/agent/reply_challenge.ts`
- Test: `src/agent/reply_challenge.test.ts`

**Interfaces:**
- Consumes: `textSimilarity(a: string, b: string): number`(`src/text/similarity.ts`,Jaccard 字符二元组,0–1)。
- Produces: `isRepeatComplaint(newMsg: string, priorUserMsgs: string[], threshold: number): boolean`——新消息与历史各条取最高相似度 ≥ threshold 则真;`threshold<=0` 或无历史 → 假。

- [ ] **Step 1: 写失败测试**

`src/agent/reply_challenge.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { isRepeatComplaint } from "./reply_challenge.js";

describe("isRepeatComplaint", () => {
  it("重提同一问题(措辞相近)→ true", () => {
    expect(isRepeatComplaint("画面还是没显示啊", ["画面没有显示"], 0.5)).toBe(true);
  });
  it("全新任务 → false", () => {
    expect(isRepeatComplaint("帮我加一个登录页", ["画面没有显示"], 0.5)).toBe(false);
  });
  it("无历史 → false", () => {
    expect(isRepeatComplaint("画面没有显示", [], 0.5)).toBe(false);
  });
  it("threshold<=0(关闭)→ 永远 false,即便完全相同", () => {
    expect(isRepeatComplaint("一样的话", ["一样的话"], 0)).toBe(false);
  });
  it("取与历史中最相似的一条比阈值", () => {
    expect(isRepeatComplaint("画面依然空白", ["加个按钮", "画面是空白的"], 0.4)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/agent/reply_challenge.test.ts`
Expected: FAIL —— `isRepeatComplaint` 未定义 / 模块不存在。

- [ ] **Step 3: 写最小实现**

`src/agent/reply_challenge.ts`:
```typescript
// 路径①:用户反复申诉 → 异步挑战者。免费相似度门(textSimilarity)判"是否重提同一问题"。
// 决策(纯函数)与执行(reflect fork,在 createReplyChallenge)分离,便于单测。
import { textSimilarity } from "../text/similarity.js";

// 新用户消息与本会话既往用户消息逐条比相似度,取最高;≥threshold 视为"重提同一问题"。
// threshold<=0 表示关闭路径①;无历史(首条消息)永远 false。
export function isRepeatComplaint(newMsg: string, priorUserMsgs: string[], threshold: number): boolean {
  if (threshold <= 0 || priorUserMsgs.length === 0) return false;
  let max = 0;
  for (const p of priorUserMsgs) {
    const s = textSimilarity(newMsg, p);
    if (s > max) max = s;
  }
  return max >= threshold;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/agent/reply_challenge.test.ts`
Expected: PASS(5 个用例全过)。

- [ ] **Step 5: Commit**

```bash
git add src/agent/reply_challenge.ts src/agent/reply_challenge.test.ts
git commit -m "feat(reflect): 路径①相似度门 isRepeatComplaint(检测用户重提同一问题)"
```

---

### Task 2: 路径② —— 修正"假进展"(`assessTurn`)

**Files:**
- Modify: `src/agent/turn_health.ts`(`assessTurn` 内 `stuck` 定义)
- Test: `src/agent/turn_health.test.ts`(更新 1 个、新增 1 个用例)

**Interfaces:**
- Consumes: 现有 `assessTurn(state, outcome, cfg, {longTask})`。
- Produces: 行为变更——`stuck = outcome.toolFailures > 0`(不再 `&& !outcome.progressed`)。即"改了文件但本轮仍有工具失败"也算卡,`failureStreak` 照常累积。

- [ ] **Step 1: 更新被反转的旧测试 + 加新测试**

在 `src/agent/turn_health.test.ts`,把原"有失败但有推进 → 不算卡住"用例(`describe("assessTurn — 挑战者(卡住)")` 内)**整体替换**为下面两个:
```typescript
  it("有失败即算卡——改了文件也不赦免(治'乱改无进展'假进展)", () => {
    let s = initHealth();
    s = assessTurn(s, fail(), cfg, { longTask: false }).next;
    // 本轮改了文件(progressed:true)但仍有工具失败 → 仍算卡,连击累积而非清零
    const d = assessTurn(s, { progressed: true, toolFailures: 1 }, cfg, { longTask: false });
    expect(d.next.failureStreak).toBe(2);
  });

  it("改文件+每轮换新错误的空转 → failureStreak 累积到阈值触发挑战者", () => {
    let s = initHealth();
    let d = assessTurn(s, { progressed: true, toolFailures: 1, errSig: "E1" }, cfg, { longTask: false }); s = d.next;
    d = assessTurn(s, { progressed: true, toolFailures: 1, errSig: "E2" }, cfg, { longTask: false }); s = d.next;
    d = assessTurn(s, { progressed: true, toolFailures: 1, errSig: "E3" }, cfg, { longTask: false });
    expect(d.challenger).toBe(true);
    expect(d.reason).toBe("failure-streak"); // 不同错每轮换 → 走 failureStreak 而非 repeated-error
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/agent/turn_health.test.ts`
Expected: FAIL —— 新用例期望 `failureStreak===2` / `challenger===true`,但现行 `stuck` 含 `&& !progressed` 会在 progressed 时清零 → 得到 0 / false。

- [ ] **Step 3: 改实现**

`src/agent/turn_health.ts`,把:
```typescript
  const stuck = outcome.toolFailures > 0 && !outcome.progressed;
```
改为:
```typescript
  // 有工具失败即算"未推进"——改了文件不赦免(治"乱改一通但错误还在/换新错"的假进展)。
  // 「失败 + 改文件」此前被 !progressed 放过,正是实测发现的盲点。progressed 仍保留给 loop 的 noProgress advisor。
  const stuck = outcome.toolFailures > 0;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/agent/turn_health.test.ts`
Expected: PASS(含更新后的两个新用例与原有其余用例)。

- [ ] **Step 5: Commit**

```bash
git add src/agent/turn_health.ts src/agent/turn_health.test.ts
git commit -m "fix(reflect): 失败即算卡——改文件不再赦免假进展(路径②)"
```

---

### Task 3: 挑战者 prompt 增补(用户申诉/前提质疑)

**Files:**
- Modify: `src/agent/reflect_prompts.ts`(`CHALLENGER_PROMPT`)
- Create: `src/agent/reflect_prompts.test.ts`

**Interfaces:**
- Consumes: 无新依赖。
- Produces: `CHALLENGER_PROMPT` 文本含"用户是否在重复表达没解决/质疑前提/若是新任务就说在轨"的自查项。

- [ ] **Step 1: 写失败测试**

`src/agent/reflect_prompts.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { CHALLENGER_PROMPT } from "./reflect_prompts.js";

describe("CHALLENGER_PROMPT", () => {
  it("含'用户重复申诉/质疑前提'自查", () => {
    expect(CHALLENGER_PROMPT).toContain("重复");
    expect(CHALLENGER_PROMPT).toContain("前提");
  });
  it("含'新任务则说在轨、不硬找茬'的免误报出口", () => {
    expect(CHALLENGER_PROMPT).toContain("在轨");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/agent/reflect_prompts.test.ts`
Expected: FAIL —— 现有 `CHALLENGER_PROMPT` 不含"前提""在轨"等字样。

- [ ] **Step 3: 改实现**

`src/agent/reflect_prompts.ts`,把 `CHALLENGER_PROMPT` 整体替换为:
```typescript
export const CHALLENGER_PROMPT = `你是"审视者",对当前进展做一次独立、怀疑性的复核。你看到完整上下文。不要继续干活,只评估、只输出结论。
1) 先用最合理的方式复述"现在在做什么、目标是什么"(别曲解成更蠢的版本)。
2) 只挑最关键的 1–3 点,每条必须扎根对话里的具体证据(引用文件/报错/命令),不要泛泛的"可能有问题":
   · 进展在收敛,还是在原地打转/反复试同一类改动?改了文件 ≠ 有进展——验收/错误状态真的变了吗?
   · 用户是否在【重复表达同一问题没解决】(如"还是不行/依然空白")?若是,别再叠加修复——质疑诊断与前提:bug 是否真在你以为的位置?是否该从头复现真实症状、或向用户要具体复现步骤?
   · 是否攻错了层?有没有把未验证的假设当事实?给一个最可能的根因:"根因可能是 X,因为 Y"。
3) 结尾给一句最小的下一步建议(绝不只留反对意见)。
若其实一切正常、或这只是个新任务,直接说"在轨,继续",不要硬找茬。
全部 ≤ 8 行。你给的是参考,不是命令。`;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/agent/reflect_prompts.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/agent/reflect_prompts.ts src/agent/reflect_prompts.test.ts
git commit -m "feat(reflect): 挑战者 prompt 增补用户申诉/前提质疑/免误报出口"
```

---

### Task 4: 异步挑战者控制器 `createReplyChallenge`

**Files:**
- Modify: `src/agent/reply_challenge.ts`(在 Task 1 文件追加)
- Test: `src/agent/reply_challenge.test.ts`(追加 describe)

**Interfaces:**
- Consumes: `isRepeatComplaint`(Task 1)。
- Produces:
  - `createReplyChallenge(deps: { reflect: () => Promise<string | null>; threshold: number }): { onUserMessage(text: string): Promise<void>; drain(): string[] }`
  - `onUserMessage`:记录历史;命中相似度门则**异步** fork(`reflect()`),结论入队(`[审视者·参考]\n…`)。调用方不 await(非阻塞);测试可 await 返回的 promise。
  - `drain`:取出并清空队列。

- [ ] **Step 1: 写失败测试**

在 `src/agent/reply_challenge.test.ts` 追加:
```typescript
import { createReplyChallenge } from "./reply_challenge.js";

describe("createReplyChallenge", () => {
  it("重提同一问题 → fork 挑战者,结论入队(带前缀),drain 取出后清空", async () => {
    let calls = 0;
    const rc = createReplyChallenge({ reflect: async () => { calls++; return "根因可能是 X"; }, threshold: 0.5 });
    await rc.onUserMessage("画面没有显示");      // 首条:无历史,不触发
    await rc.onUserMessage("画面还是没显示啊");  // 重提:触发
    expect(calls).toBe(1);
    const drained = rc.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toContain("审视者·参考");
    expect(drained[0]).toContain("根因可能是 X");
    expect(rc.drain()).toHaveLength(0);          // 已清空
  });
  it("全新任务 → 不 fork,队列空", async () => {
    let calls = 0;
    const rc = createReplyChallenge({ reflect: async () => { calls++; return "x"; }, threshold: 0.5 });
    await rc.onUserMessage("画面没有显示");
    await rc.onUserMessage("帮我加一个登录页");
    expect(calls).toBe(0);
    expect(rc.drain()).toHaveLength(0);
  });
  it("挑战者返回 null/空 → 不入队", async () => {
    const rc = createReplyChallenge({ reflect: async () => null, threshold: 0.5 });
    await rc.onUserMessage("画面没有显示");
    await rc.onUserMessage("画面还是没显示");
    expect(rc.drain()).toHaveLength(0);
  });
  it("reflect 抛错 → 吞掉、不入队、不抛", async () => {
    const rc = createReplyChallenge({ reflect: async () => { throw new Error("flash down"); }, threshold: 0.5 });
    await rc.onUserMessage("画面没有显示");
    await expect(rc.onUserMessage("画面还是没显示")).resolves.toBeUndefined();
    expect(rc.drain()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/agent/reply_challenge.test.ts`
Expected: FAIL —— `createReplyChallenge` 未定义。

- [ ] **Step 3: 写实现**

在 `src/agent/reply_challenge.ts` 末尾追加:
```typescript
export interface ReplyChallengeDeps {
  reflect: () => Promise<string | null>; // fork 挑战者,返回结论文本或 null(由 index 绑定为 () => reflect("challenger"))
  threshold: number;                     // 相似度阈值;<=0 关闭路径①
}

// 异步挑战者控制器:用户消息入口判申诉、命中才 fork(不阻塞),结论入队待回合边界注入。
export function createReplyChallenge(deps: ReplyChallengeDeps) {
  const history: string[] = []; // 本会话既往用户消息(仅真实用户消息,不含斜杠命令)
  const queue: string[] = [];   // 待注入的挑战者结论(已带 [审视者·参考] 前缀)
  return {
    // 非阻塞:命中相似度门才 fork。调用方【不要 await】(fire-and-forget);测试可 await 以等待入队。
    onUserMessage(text: string): Promise<void> {
      const repeat = isRepeatComplaint(text, history, deps.threshold);
      history.push(text);
      if (!repeat) return Promise.resolve();
      return deps.reflect()
        .then((v) => { if (v && v.trim()) queue.push(`[审视者·参考]\n${v.trim()}`); })
        .catch(() => {}); // 反思失败绝不波及主流程
    },
    drain(): string[] { return queue.splice(0); },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/agent/reply_challenge.test.ts`
Expected: PASS(全部用例)。

- [ ] **Step 5: Commit**

```bash
git add src/agent/reply_challenge.ts src/agent/reply_challenge.test.ts
git commit -m "feat(reflect): 异步挑战者控制器(相似度门→fork→入队drain,不阻塞)"
```

---

### Task 5: `runTurn` 回合边界注入 `drainAdvisories`

**Files:**
- Modify: `src/agent/loop.ts`(`TurnDeps` 加字段 + 回合边界注入)
- Test: `src/agent/loop.test.ts`(追加 1 用例)

**Interfaces:**
- Consumes: 无新依赖。
- Produces: `TurnDeps.drainAdvisories?: () => string[]`;`runTurn` 在每个工具回合边界(现有 `drainPending` 注入处之后)把 drain 出的每条作为 `{ role: "system", content }` push 进 `session.messages`。

- [ ] **Step 1: 写失败测试**

在 `src/agent/loop.test.ts` 的 `describe("runTurn", …)` 内追加:
```typescript
  it("drainAdvisories:回合边界把结论注入为 system 消息", async () => {
    const s = new Session("SYS", "m");
    s.addUser("go");
    let drained = false;
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" }) as any,
      executeToolCalls: async () => [],
      write: () => {},
      drainAdvisories: () => (drained ? [] : (drained = true, ["[审视者·参考]\n根因可能是 X"])),
    });
    expect(s.messages.some((m) => m.role === "system" && String(m.content).includes("审视者·参考"))).toBe(true);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/agent/loop.test.ts`
Expected: FAIL —— `drainAdvisories` 未被消费,无 system 消息含"审视者·参考"。

- [ ] **Step 3: 改实现**

`src/agent/loop.ts`,在 `TurnDeps` 接口里(紧挨现有 `drainPending?` 字段)加:
```typescript
  // 回合边界注入的 advisory(system 角色);用于异步挑战者结论"本回合内尽量接住"。省略=不注入。
  drainAdvisories?: () => string[];
```
并在回合循环里,现有 `drainPending` 注入块**之后**(`for (const m of deps.drainPending()) …` 那个 `if` 块后)加:
```typescript
    // 异步挑战者结论:回合边界 drain 注入为 system advisory(本回合内接住即当轮生效)。
    if (deps.drainAdvisories) {
      for (const a of deps.drainAdvisories()) session.messages.push({ role: "system", content: a });
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/agent/loop.test.ts`
Expected: PASS(新用例 + 原有用例)。

- [ ] **Step 5: Commit**

```bash
git add src/agent/loop.ts src/agent/loop.test.ts
git commit -m "feat(loop): runTurn 回合边界注入 drainAdvisories(system advisory)"
```

---

### Task 6: 接线 index.ts / repl.ts + 文档

**Files:**
- Modify: `src/index.ts`(创建控制器、两处 `runTurn` 加 `drainAdvisories`、Ink 入口调 `onUserMessage`、`runRepl` 传 `onUserMessage`)
- Modify: `src/repl.ts`(`ReplDeps` 加 `onUserMessage?`,入回合前调用)
- Test: `src/repl.test.ts`(追加 1 用例)
- Modify: `README.md`、`README.en.md`、`CHANGELOG.md`(`DAO_CHALLENGE_REPEAT_SIM`)

**Interfaces:**
- Consumes: `createReplyChallenge`(Task 4)、`reflect("challenger")`(`index.ts` 现有)、`drainAdvisories`(Task 5)。
- Produces: 交互式(REPL + Ink)两条路径都接路径①;一次性 argv 路径不接。

- [ ] **Step 1: repl.ts 加 `onUserMessage` 依赖 + 失败测试**

`src/repl.ts`,`ReplDeps` 接口追加:
```typescript
  // 真实用户消息入回合前回调(由 index 绑定 replyChallenge.onUserMessage;省略=不处理)。
  onUserMessage?: (text: string) => void;
```
在 `runRepl` 里,`await deps.runTurn();`(真实用户行那次,第 55 行附近)**之前**加一行:
```typescript
    deps.onUserMessage?.(line);
```

`src/repl.test.ts` 追加:
```typescript
  it("真实用户消息触发 onUserMessage(斜杠命令不触发)", async () => {
    const got: string[] = [];
    const lines = ["/help", "画面没显示", null];
    let i = 0;
    await runRepl({
      session: new Session("SYS", "m"),
      readLine: async () => lines[i++] ?? null,
      runTurn: async () => {},
      compact: async () => {},
      write: () => {},
      onUserMessage: (t) => got.push(t),
    });
    expect(got).toEqual(["画面没显示"]);
  });
```
(若 `repl.test.ts` 未导入 `Session`,在文件顶部加 `import { Session } from "./session/session.js";`。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/repl.test.ts`
Expected: 先 FAIL(`onUserMessage` 尚未在 `runRepl` 中调用 / 类型未定义),实现后转 PASS。

- [ ] **Step 3: index.ts 创建控制器并接线**

在 `src/index.ts`,`runOneTurn` 定义之前(`reflect` 已定义之后,约第 1070 行附近)加:
```typescript
  // 路径①:用户反复申诉 → 异步挑战者。仅交互式接(argv 一次性不接此入口)。阈值默认 0.5,DAO_CHALLENGE_REPEAT_SIM=0 关。
  const replyChallenge = createReplyChallenge({
    reflect: () => reflect("challenger"),
    threshold: process.env.DAO_CHALLENGE_REPEAT_SIM !== undefined ? Number(process.env.DAO_CHALLENGE_REPEAT_SIM) : 0.5,
  });
```
文件顶部 import 区加:
```typescript
import { createReplyChallenge } from "./agent/reply_challenge.js";
```
`runOneTurn` 里的 `runTurn({ … })` 调用,在 `longTask,` 一行后加:
```typescript
      drainAdvisories: () => replyChallenge.drain(),
```
Ink 路径 `submit` 回调里:在 `session.addUser(text);` 之后加:
```typescript
          void replyChallenge.onUserMessage(text); // 非阻塞:命中相似度门才异步 fork 挑战者
```
并在该 `submit` 的 `runTurn({ … })` 调用 `longTask,` 一行后加:
```typescript
            drainAdvisories: () => replyChallenge.drain(),
```
`runRepl({ … })` 调用(约第 1660 行)追加参数:
```typescript
        onUserMessage: (text) => { void replyChallenge.onUserMessage(text); },
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `npx vitest run src/repl.test.ts && npx tsc --noEmit`
Expected: repl 测试 PASS;tsc 无错误。

- [ ] **Step 5: 文档(README 中英 + CHANGELOG)**

`README.md` 配置表(`DAO_AUTO_APPROVE` 行后)加:
```markdown
| `DAO_CHALLENGE_REPEAT_SIM` | 路径①:用户重提同一问题的相似度阈值,达到则异步唤起审视者(`0`=关;仅交互式) | `0.5` |
```
`README.en.md` 同处加:
```markdown
| `DAO_CHALLENGE_REPEAT_SIM` | Reply-challenger: similarity threshold for "user is re-raising the same problem" → async challenger (`0`=off; interactive only) | `0.5` |
```
`CHANGELOG.md` 的 `## [Unreleased]` 下 `### 变更`(或新建)追加:
```markdown
- **挑战者触发完善**:失败即算卡(改文件不再赦免"假进展");新增"用户重提同一问题"异步触发审视者(`DAO_CHALLENGE_REPEAT_SIM` 默认 0.5,`=0` 关),fork 不阻塞、结论回合边界注入。
```

- [ ] **Step 6: 全量回归 + Commit**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全绿、无类型错误。
```bash
git add src/index.ts src/repl.ts src/repl.test.ts README.md README.en.md CHANGELOG.md
git commit -m "feat(reflect): 接线路径①(REPL+Ink 入口异步挑战者)+ 配置/文档"
```

---

## Self-Review

**Spec coverage:**
- 路径② 假进展修正 → Task 2 ✓
- 路径① 相似度门 → Task 1 ✓;异步控制器(非阻塞 + 入队)→ Task 4 ✓;回合边界注入 → Task 5 ✓;入口接线(REPL+Ink,argv 不接)→ Task 6 ✓
- 挑战者 prompt 增强 → Task 3 ✓
- 配置 `DAO_CHALLENGE_REPEAT_SIM` + `DAO_REFLECT` 总开关(已存在,不动)→ Task 6 文档 ✓
- 读侧无竞态(reflect 入口快照)→ 由 `onUserMessage` 在 `addUser` 后即时调用 `reflect()` 保证(Task 6 接线)✓
- 测试:相似度门/assessTurn/prompt/异步注入/全量回归 → 各 Task 覆盖 ✓

**Placeholder scan:** 无 TBD/TODO;每个改代码步骤均含完整代码与精确命令。

**Type consistency:** `isRepeatComplaint(newMsg, priorUserMsgs, threshold)`、`createReplyChallenge({reflect, threshold})→{onUserMessage, drain}`、`TurnDeps.drainAdvisories?: ()=>string[]`、`ReplDeps.onUserMessage?: (text)=>void` 在定义(Task 1/4/5/6)与消费(Task 6)处签名一致。

**YAGNI:** 不做时间型零推进兜底、不做语义召回、不动纠偏者、不接 argv 一次性路径。
