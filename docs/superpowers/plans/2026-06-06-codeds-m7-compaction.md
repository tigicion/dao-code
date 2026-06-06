# codeds M7 — 上下文压缩 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现设计文档 §9 的上下文压缩:`/compact` 手动压缩(接 M5 的 stub)+ 接近上限自动兜底。压缩后保留 **系统前缀(messages[0],含记忆)+ 旧对话的生成式摘要 + 最近 N 轮原文**,防长会话硬中断。正常不早压(信任 1M 窗口、保护 cache),压缩是低频动作。

**Architecture:** 新增 `agent/compact.ts`:`estimateTokens`(粗估 token)、`shouldCompact`(是否到阈值)、`compactMessages(messages, {keepRecentTurns, summarize})`(纯函数:保留 messages[0] + 一条摘要 system 消息 + 最近 N 轮原文;摘要由注入的 `summarize` 生成)。**保留边界按 user 消息切**——每个保留的"轮"从某条 user 消息起到下条 user 之前,保证 assistant↔tool 序列完整(否则 DeepSeek 报错)。`/compact` 改为返回 `{compact:true}` 信号(纯 `dispatchCommand` 处理不了异步调模型),由 `runRepl` 执行注入的 `compact()`。index 构建 `summarize`(一次独立 streamChat、不带工具)、`runCompaction`(压缩并替换 `session.messages`),并在每轮结束后按阈值自动压缩。

**Tech Stack:** 沿用。摘要复用 `streamChat`(收集 content,不渲染)。无新依赖。

参考:设计文档 §9(压缩策略)、§10(`/compact` 会 bust cache,故低频)。M5 的 `commands.ts`/`repl.ts`/`index.ts`、M6 的记忆(摘要不动 messages[0],记忆随系统前缀保留)。

**范围与延后**:压缩**只在轮边界**触发(完整轮),单个超长 turn(一轮内 tool 轮次撑爆窗口)不在 P1 处理——1M 窗口下极难单轮触顶,记 carry-over。摘要质量依赖模型;自动压缩阈值默认按 1M 窗口的 85%,实际罕触发(主要靠手动 `/compact`),自动路径以单测决策函数为主。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/agent/compact.ts` | `estimateTokens` / `shouldCompact` / `compactMessages` | 新建 |
| `src/commands/commands.ts` | `/compact` → `{handled,compact:true}`(替换 stub) | 改 |
| `src/repl.ts` | `ReplDeps` 加 `compact`;处理 `cmd.compact` | 改 |
| `src/index.ts` | `summarize` + `runCompaction` + 轮后自动压缩;传 compact 给 runRepl | 改 |

---

## Task 1: 压缩核心(estimateTokens / shouldCompact / compactMessages)

**Files:** Create `src/agent/compact.ts`, Test `src/agent/compact.test.ts`

**契约:**
- `estimateTokens(messages): number` —— 粗估:累计各消息 content 字符 + assistant 的 tool_calls(name+arguments)字符,`/3` 向上取整(中英混排约 3 字符/token)。
- `shouldCompact(messages, maxTokens, ratio=0.85): boolean` —— `estimateTokens >= maxTokens*ratio`。
- `compactMessages(messages, {keepRecentTurns, summarize}): Promise<ChatMessage[]>` —— 保 messages[0];按 user 消息边界保留最近 `keepRecentTurns` 轮原文;其余(messages[0] 与保留尾之间)交 `summarize` 生成摘要,作为第二条 system 消息 `[早期对话摘要]\n...` 插入。user 轮数 ≤ keepRecentTurns 或无可摘要 → 原样返回(no-op)。

- [ ] **Step 1: 失败测试 `src/agent/compact.test.ts`(EXACT)**
```ts
import { describe, it, expect } from "vitest";
import { estimateTokens, shouldCompact, compactMessages } from "./compact.js";
import type { ChatMessage } from "../client/types.js";

const sys: ChatMessage = { role: "system", content: "SYSTEM PREFIX" };
function user(t: string): ChatMessage { return { role: "user", content: t }; }
function asst(t: string): ChatMessage { return { role: "assistant", content: t }; }

describe("estimateTokens", () => {
  it("scales with content length and counts tool_calls args", () => {
    const t1 = estimateTokens([user("abc")]);
    const t2 = estimateTokens([user("abcdef")]);
    expect(t2).toBeGreaterThan(t1);
    const withTool = estimateTokens([
      { role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] },
    ]);
    expect(withTool).toBeGreaterThan(0);
  });
});

describe("shouldCompact", () => {
  it("true only at/over the threshold", () => {
    const msgs = [user("x".repeat(300))]; // ~100 tokens
    expect(shouldCompact(msgs, 1000, 0.05)).toBe(true);   // 50 token 阈值
    expect(shouldCompact(msgs, 1000, 0.9)).toBe(false);   // 900 token 阈值
  });
});

describe("compactMessages", () => {
  const summarize = async (msgs: ChatMessage[]) => `SUMMARY(${msgs.length})`;

  it("is a no-op when there are not more than keepRecentTurns user turns", async () => {
    const msgs = [sys, user("u1"), asst("a1"), user("u2"), asst("a2")];
    const out = await compactMessages(msgs, { keepRecentTurns: 2, summarize });
    expect(out).toEqual(msgs);
  });

  it("keeps system + summary + recent N turns (verbatim), summarizing the middle", async () => {
    const msgs = [
      sys,
      user("u1"), asst("a1"),
      user("u2"), asst("a2"),
      user("u3"), asst("a3"),
    ];
    const out = await compactMessages(msgs, { keepRecentTurns: 1, summarize });
    // 保留: sys, 摘要, 最近 1 轮 (u3,a3)
    expect(out[0]).toEqual(sys);
    expect(out[1]!.role).toBe("system");
    expect(out[1]!.content).toContain("早期对话摘要");
    expect(out[1]!.content).toContain("SUMMARY(4)"); // u1,a1,u2,a2 被摘要 = 4 条
    expect(out.slice(2)).toEqual([user("u3"), asst("a3")]);
  });

  it("keeps complete turns including tool messages in the recent tail", async () => {
    const toolTurn: ChatMessage[] = [
      user("do it"),
      { role: "assistant", content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c0", content: "RESULT" },
      asst("done"),
    ];
    const msgs = [sys, user("old"), asst("oldA"), ...toolTurn];
    const out = await compactMessages(msgs, { keepRecentTurns: 1, summarize });
    // 最近 1 轮 = 完整的 toolTurn(user+assistant(tool_calls)+tool+assistant)
    expect(out.slice(2)).toEqual(toolTurn);
  });
});
```

- [ ] **Step 2:** `npx vitest run src/agent/compact.test.ts` — FAIL。

- [ ] **Step 3: 写 `src/agent/compact.ts`(EXACT)**
```ts
import type { ChatMessage } from "../client/types.js";

// 粗估 token:中英混排约 3 字符/token;统计 content 与 assistant 的 tool_calls。
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        chars += tc.function.name.length + tc.function.arguments.length;
      }
    }
  }
  return Math.ceil(chars / 3);
}

export function shouldCompact(messages: ChatMessage[], maxTokens: number, ratio = 0.85): boolean {
  return estimateTokens(messages) >= maxTokens * ratio;
}

export interface CompactOptions {
  keepRecentTurns: number; // 保留最近多少个 user 轮的原文
  summarize: (messages: ChatMessage[]) => Promise<string>;
}

// 压缩:保留 messages[0](系统前缀+记忆)+ 旧对话摘要 + 最近 N 轮原文。
// 按 user 消息切轮,保证保留的轮里 assistant↔tool 序列完整。
export async function compactMessages(
  messages: ChatMessage[],
  opts: CompactOptions,
): Promise<ChatMessage[]> {
  if (messages.length === 0) return messages;
  const system = messages[0]!;
  const rest = messages.slice(1);

  const userIdx: number[] = [];
  rest.forEach((m, i) => {
    if (m.role === "user") userIdx.push(i);
  });
  if (userIdx.length <= opts.keepRecentTurns) return messages;

  const tailStart = userIdx[userIdx.length - opts.keepRecentTurns]!;
  const toSummarize = rest.slice(0, tailStart);
  const tail = rest.slice(tailStart);
  if (toSummarize.length === 0) return messages;

  const summary = await opts.summarize(toSummarize);
  const summaryMsg: ChatMessage = {
    role: "system",
    content: `[早期对话摘要]\n${summary}`,
  };
  return [system, summaryMsg, ...tail];
}
```

- [ ] **Step 4:** `npx vitest run src/agent/compact.test.ts` — 全 PASS(5 用例)。
- [ ] **Step 5:** `npx tsc --noEmit` — clean。
- [ ] **Step 6:** 提交
```bash
cd /Users/huaruoxu/ClaudeProject/career_plan/code/codeds
git add src/agent/compact.ts src/agent/compact.test.ts
git commit -m "feat(agent): context compaction core (estimate/should/compactMessages)"
```

---

## Task 2: /compact 命令(替换 stub)

**Files:** Modify `src/commands/commands.ts`, `src/commands/commands.test.ts`

**契约:** `CommandResult` 加可选 `compact?: boolean`。`/compact` 不再返回"尚未实现",改为 `{ handled: true, compact: true }`(无 output;由 REPL 执行并打印结果)。

- [ ] **Step 1: 改 `src/commands/commands.ts`** ——
  (a) `CommandResult` 接口加字段:
```ts
export interface CommandResult {
  handled: boolean;
  output?: string;
  exit?: boolean;
  compact?: boolean;
}
```
  (b) `case "compact":` 改为:
```ts
    case "compact":
      return { handled: true, compact: true };
```
  (c) `/help` 文本里把 `/compact(待实现)` 改成 `/compact 压缩对话`:
```ts
        output: "/model [id] 切模型 · /plan 切模式 · /clear 清空 · /compact 压缩对话 · /exit 退出",
```

- [ ] **Step 2: 改 `src/commands/commands.test.ts`** —— 把原 `/compact reports not-yet-implemented` 用例替换为:
```ts
  it("/compact signals compaction", () => {
    const r = dispatchCommand("/compact", sess());
    expect(r.handled).toBe(true);
    expect(r.compact).toBe(true);
  });
```

- [ ] **Step 3:** `npx vitest run src/commands/commands.test.ts` — 8 PASS。
- [ ] **Step 4:** `npx tsc --noEmit`(repl.ts/index.ts 此刻可能因还没用 compact 而无错;若 repl 的 ReplDeps 还没改也无错——确认 commands 部分干净)。
- [ ] **Step 5:** 提交
```bash
git add src/commands/commands.ts src/commands/commands.test.ts
git commit -m "feat(commands): /compact signals compaction (was stub)"
```

---

## Task 3: REPL 执行 /compact

**Files:** Modify `src/repl.ts`, `src/repl.test.ts`

**契约:** `ReplDeps` 加 `compact: () => Promise<void>`。`runRepl` 在 `cmd.handled` 分支里:若 `cmd.compact` → `await deps.compact()` 后 `continue`(不走 output/exit)。

- [ ] **Step 1: 改 `src/repl.ts`** ——
  (a) `ReplDeps` 加:
```ts
  // 执行一次压缩(由 index 绑定:压缩 session.messages 并打印结果)。
  compact: () => Promise<void>;
```
  (b) 在 `runRepl` 的 `if (cmd.handled) {` 块最前面加 compact 分支:
```ts
    if (cmd.handled) {
      if (cmd.compact) {
        await deps.compact();
        continue;
      }
      if (cmd.output) deps.write(cmd.output + "\n");
      if (cmd.exit) return;
      continue;
    }
```

- [ ] **Step 2: 改 `src/repl.test.ts`** ——
  (a) 给现有 3 个 `runRepl({...})` 调用各加一行 `compact: async () => {},`(ReplDeps 现在要求它)。
  (b) 追加一个测试(在 describe 内):
```ts
  it("invokes compact on /compact", async () => {
    const s = new Session("SYS", "m");
    let compacted = 0;
    await runRepl({
      session: s,
      readLine: lineFeeder(["/compact", "/exit"]),
      runTurn: async () => {},
      compact: async () => { compacted++; },
      write: () => {},
    });
    expect(compacted).toBe(1);
  });
```

- [ ] **Step 3:** `npx vitest run src/repl.test.ts` — 4 PASS。
- [ ] **Step 4:** `npx tsc --noEmit`。Expected:报错只在 `src/index.ts`(runRepl 调用还没传 compact)——预期,Task 4 修。确认错误只在 index.ts。
- [ ] **Step 5:** 提交
```bash
git add src/repl.ts src/repl.test.ts
git commit -m "feat(repl): execute /compact via injected compact()"
```

---

## Task 4: 装配 index(summarize + 压缩 + 自动兜底)+ 全量验收

**Files:** Modify `src/index.ts`

- [ ] **Step 1: 改 `src/index.ts`** ——
  (a) 顶部 import 增加:
```ts
import { compactMessages, shouldCompact } from "./agent/compact.js";
import type { ChatMessage } from "./client/types.js";
```
  (b) 在 `runOneTurn` 定义之前,加 `summarize` 与 `runCompaction`(用到 `cfg`、`session`、`streamChat`、`write`,它们此处都已在作用域内):
```ts
  const KEEP_RECENT_TURNS = 2;
  const CONTEXT_WINDOW = 1_000_000;

  // 压缩用:对一批旧消息生成简洁摘要(独立一次 streamChat,不带工具,不流式渲染)。
  const summarize = async (msgs: ChatMessage[]): Promise<string> => {
    const rendered = msgs
      .map((m) => {
        if (m.role === "assistant" && m.tool_calls) {
          const calls = m.tool_calls.map((t) => `${t.function.name}(${t.function.arguments})`).join(", ");
          return `[assistant 调用工具] ${calls}${m.content ? `\n${m.content}` : ""}`;
        }
        return `[${m.role}] ${typeof m.content === "string" ? m.content : ""}`;
      })
      .join("\n");
    const gen = streamChat({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: session.model,
      messages: [
        { role: "system", content: "你是对话压缩器。把给定的早期对话压缩成简洁中文摘要,保留:关键事实与用户偏好、已做的文件改动与命令、做出的决定、未完成事项。只输出摘要正文,不要寒暄。" },
        { role: "user", content: rendered },
      ],
    });
    let out = "";
    let r = await gen.next();
    while (!r.done) {
      if (r.value.kind === "content") out += r.value.text;
      r = await gen.next();
    }
    return out.trim() || (typeof r.value.content === "string" ? r.value.content : "(摘要为空)");
  };

  const runCompaction = async (): Promise<void> => {
    const before = session.messages.length;
    session.messages = await compactMessages(session.messages, {
      keepRecentTurns: KEEP_RECENT_TURNS,
      summarize,
    });
    const after = session.messages.length;
    write(after < before ? `\n[已压缩对话:${before} → ${after} 条消息]\n` : `\n[对话较短,无需压缩]\n`);
  };
```
  (c) 把 `runOneTurn` 改为跑完后做自动压缩兜底:
```ts
  const runOneTurn = async () => {
    await runTurn({
      session,
      config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
      registry,
      ctx,
      gate,
      streamChat,
      executeToolCalls,
      write,
    });
    if (shouldCompact(session.messages, CONTEXT_WINDOW)) {
      write("\n[接近上限,自动压缩…]\n");
      await runCompaction();
    }
  };
```
  (d) 把 `runRepl({ session, readLine, runTurn: runOneTurn, write })` 改为带上 compact:
```ts
    await runRepl({ session, readLine, runTurn: runOneTurn, write, compact: runCompaction });
```
  (其余 index 不变。)

- [ ] **Step 2: 全量 typecheck** —— `npx tsc --noEmit`,退出 0。
- [ ] **Step 3: 全量测试** —— `npx vitest run`,全 PASS。预期新增:agent/compact(5);commands/repl 用例数微调;在 M6 的 150 基础上 ≈ **~156 用例**。报实际总数。
- [ ] **Step 4: 无网络冒烟** ——
  `DEEPSEEK_API_KEY= npm run dev -- "hi"` → 含 "Missing DEEPSEEK_API_KEY",退出 1。
  REPL 命令:`printf '/help\n/exit\n' | DEEPSEEK_API_KEY=x npm run dev` → banner + help(含 "/compact 压缩对话")+ "再见。",退出 0。
- [ ] **Step 5:** 提交
```bash
cd /Users/huaruoxu/ClaudeProject/career_plan/code/codeds
git add src/index.ts
git commit -m "feat: wire /compact + auto-compaction with model summarizer"
```

---

## Task 5: 真网络/端到端验收(/compact 保留事实)

> key 桥接,不回显。**由 controller 执行。** 默认 `KEEP_RECENT_TURNS=2`,故 3 个 user 轮后 `/compact` 会摘要最早 1 轮、保留最近 2 轮。

- [ ] **Step 1: REPL 多轮 → /compact → 问被摘要轮里的事实** ——
```bash
set -a && . ./.env && set +a && printf '我叫 Alex,在做一个叫 codeds 的 TypeScript 项目\n这个项目用 vitest 做测试\n今天先聊到这\n/compact\n我叫什么名字?项目叫什么?用什么测试框架?直接回答,别调用工具\n/exit\n' | DEEPSEEK_API_KEY="$DS_API_KEY" npm run dev 2>&1; echo "---EXIT=$?---"
```
Expected:三轮对话后 `/compact` 打印 `[已压缩对话:N → M 条消息]`(M<N,把最早 1 轮摘要、保留最近 2 轮);随后提问时,**即便"我叫 Alex / 项目叫 codeds"那轮已被摘要**,模型仍能据摘要答出 **Alex / codeds / vitest**(vitest 在保留的近轮里、name/项目在摘要里)。退出 0。这验证压缩保留了关键事实、且 assistant↔tool 边界没切坏(本例无工具调用,边界平凡)。

- [ ] **Step 2: 记录结论** —— 把 M7 验收结果一句话追加到设计文档 §9 末尾(/compact 可压缩、摘要保留事实、自动兜底已接)。提交:
```bash
git add docs/2026-06-04-deepseek-coding-agent-design.md
git commit -m "docs: record M7 compaction acceptance"
```

---

## 验收标准(M7 完成的定义)

- [ ] `npx vitest run` 全绿(约 156 用例)。
- [ ] `npx tsc --noEmit` 零错。
- [ ] 缺 key / REPL 命令冒烟正常(help 含 "/compact 压缩对话")。
- [ ] compact 核心:estimateTokens 随长度增长、计 tool_calls;shouldCompact 阈值边界;compactMessages no-op(短)/ 保留 system+摘要+最近N轮 / 保留完整 tool 轮(有测试)。
- [ ] /compact 命令返回 `{compact:true}`;REPL 调 `compact()`(有测试)。
- [ ] 压缩保留 messages[0](系统前缀+记忆);摘要为第二条 system 消息;最近轮按 user 边界完整保留。
- [ ] 真网络:/compact 打印压缩结果,且被摘要轮的事实仍可答出。

## 给后续里程碑留的 carry-over

- **单轮超长**:压缩只在轮边界触发;一轮内 tool 轮次撑爆窗口不在 P1 处理(1M 窗口下极难)。需要时可在 runTurn 的 tool 轮间加"轮内压缩"(保留最近若干 assistant/tool,摘要更早的)。
- **摘要模型**:现用 `session.model`;可固定用 flash 省钱(摘要不需 Pro)。
- **自动压缩阈值**:默认 1M*0.85,实际罕触发;可暴露成配置/`/compact` 提示。
- **/compact 的 cache bust**:压缩重写历史会 bust 前缀 cache(§10 已知,低频可接受)。
- **摘要 system 消息兼容性**:摘要作第二条 system 消息;若某模型只认单 system,可改 user 消息(真网络已验证当前可用)。
- **M2–M6 旧 carry-over**仍在(子代理→M8、富 TUI→M9、项目指令文件加载、记忆 P2/P3、edit_file 越界测试、执行器并发回归测试、approval 三档、web_search 健壮性、注册顺序断言、§10 注入一次集成测试)。
- 下一步:M8 子代理(`agent` 工具,一次性派发)→ M9 TUI。