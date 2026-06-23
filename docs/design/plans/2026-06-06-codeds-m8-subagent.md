# codeds M8 — 子代理 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现设计文档 §6 的子代理:`agent` 工具**一次性派发**一个独立子任务给子代理,子代理用同样的工具集自主跑完(一个 user 轮内的多轮工具循环),**只把最终结果作为一条工具消息回给主 agent**——主 agent 的上下文看不到子过程(Claude Code Task 式)。

**Architecture:** 子代理 = 一个**全新 Session**(系统 prompt + 记忆 + 仅 task 这一条 user 消息,不带主对话历史 → 上下文隔离)+ 复用 `runTurn` 跑到底,取最后一条 assistant 文本作为结果。逻辑抽到 `agent/subagent.ts` 的 `runSubagent(deps)`(注入 `runTurn` → 可单测)。`agent` 工具经 `ctx.runSubagent` 调用(延续 ctx 注入能力的模式)。**防递归**:`ctx.subagentDepth`,子代理内 ctx 的 depth=1,agent 工具在 depth≥1 时直接拒绝(执行层强制,类比 plan 模式)。**模式继承**:子代理继承主会话 mode(plan 下子代理也只读)。**审批仍生效**:子代理用同一个 gate(共用 stdin),其写/执行照样弹审批(§6)。子代理的流式输出渲染给用户(`[子代理开始]`/`[子代理完成]` 标记,透明展示进度),但**主 agent 的 messages 只收到最终结果字符串**。

**Tech Stack:** 沿用。无新依赖。

参考:设计文档 §3(不要无故递归自己)、§4(`agent` approval Auto,子代理内写/执行仍受审批)、§6(一次性派发、上下文隔离)。M5 的 `Session`/`runTurn`/`TurnDeps`、M3 的 gate、M6 记忆(子代理复用主系统 prompt,含记忆)。

**范围与延后**:持久子会话(open/eval/close 式,CodeWhale)不做——只一次性派发(§2 决策)。子代理**完成事件回传主 agent 更新 todo_write**:本 P1 通过"最终结果作为工具消息"实现,主 agent 据此自行更新 todo(无单独事件通道)。子代理不嵌套(depth 限 1)。并行多子代理(一轮多个 agent tool_call)由现有并发执行器天然支持,但每个子代理内部串行——并行收益与隔离已够,不额外做。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/agent/subagent.ts` | `runSubagent`(新 Session + runTurn + 取最终结果) | 新建 |
| `src/tools/types.ts` | `ToolContext` 加 `runSubagent?` / `subagentDepth?` | 改 |
| `src/tools/agent.ts` | `agent` 工具(委托 ctx.runSubagent,防递归) | 新建 |
| `src/index.ts` | 构建 `ctx.runSubagent` 闭包;注册 `agent` 工具 | 改 |

---

## Task 1: 子代理执行器 runSubagent

**Files:** Create `src/agent/subagent.ts`, Test `src/agent/subagent.test.ts`

**契约:** `runSubagent(deps): Promise<string>` —— 写 `[子代理开始]`;建新 `Session(systemPrompt, model)`、设 `mode`、`addUser(task)`;调注入的 `runTurn`(ctx 用 `{...deps.ctx, subagentDepth: (旧+1)}`);写 `[子代理完成]`;返回子会话最后一条 assistant 的 content(无则 `(子代理无最终输出)`)。

- [ ] **Step 1: 失败测试 `src/agent/subagent.test.ts`(EXACT)**
```ts
import { describe, it, expect } from "vitest";
import { runSubagent, type SubagentDeps } from "./subagent.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ApprovalGate } from "../approval/types.js";
import type { TurnDeps } from "./loop.js";

const stubGate: ApprovalGate = { needsApproval: () => false, requestBatch: async () => new Map() };

function baseDeps(overrides: Partial<SubagentDeps>): SubagentDeps {
  return {
    task: "do X",
    systemPrompt: "SUB SYS",
    model: "deepseek-v4-pro",
    mode: "normal",
    config: { baseUrl: "", apiKey: "" },
    registry: new ToolRegistry(),
    ctx: { workspaceRoot: "/tmp" },
    gate: stubGate,
    streamChat: (() => {}) as unknown as TurnDeps["streamChat"],
    executeToolCalls: async () => [],
    write: () => {},
    runTurn: async () => {},
    ...overrides,
  };
}

describe("runSubagent", () => {
  it("runs the task on a fresh session and returns the final assistant content", async () => {
    const written: string[] = [];
    const result = await runSubagent(
      baseDeps({
        write: (s) => written.push(s),
        runTurn: async (deps) => {
          // 子代理应只有 system + user(task),无主对话历史
          expect(deps.session.messages.map((m) => m.role)).toEqual(["system", "user"]);
          deps.session.messages.push({ role: "assistant", content: "子代理结果" });
        },
      }),
    );
    expect(result).toBe("子代理结果");
    expect(written.join("")).toContain("子代理开始");
    expect(written.join("")).toContain("子代理完成");
  });

  it("increments subagentDepth in the sub-ctx passed to runTurn", async () => {
    let seenDepth: number | undefined;
    await runSubagent(
      baseDeps({
        ctx: { workspaceRoot: "/tmp", subagentDepth: 0 },
        runTurn: async (deps) => {
          seenDepth = deps.ctx.subagentDepth;
          deps.session.messages.push({ role: "assistant", content: "x" });
        },
      }),
    );
    expect(seenDepth).toBe(1);
  });

  it("inherits the given mode", async () => {
    let seenMode: string | undefined;
    await runSubagent(
      baseDeps({
        mode: "plan",
        runTurn: async (deps) => {
          seenMode = deps.session.mode;
          deps.session.messages.push({ role: "assistant", content: "x" });
        },
      }),
    );
    expect(seenMode).toBe("plan");
  });

  it("returns a placeholder when there is no assistant output", async () => {
    const result = await runSubagent(baseDeps({ runTurn: async () => {} }));
    expect(result).toContain("无最终输出");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/agent/subagent.test.ts` — FAIL。

- [ ] **Step 3: 写 `src/agent/subagent.ts`(EXACT)**
```ts
import { Session } from "../session/session.js";
import type { Mode } from "../tools/tools_for_mode.js";
import type { ToolContext } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ApprovalGate } from "../approval/types.js";
import type { TurnDeps } from "./loop.js";

export interface SubagentDeps {
  task: string;
  systemPrompt: string;
  model: string;
  mode: Mode;
  config: { baseUrl: string; apiKey: string };
  registry: ToolRegistry;
  ctx: ToolContext;
  gate: ApprovalGate;
  streamChat: TurnDeps["streamChat"];
  executeToolCalls: TurnDeps["executeToolCalls"];
  write: (s: string) => void;
  runTurn: (deps: TurnDeps) => Promise<void>;
}

// 一次性派发:全新隔离会话(系统 prompt + task)跑到底,返回最终 assistant 文本。
export async function runSubagent(deps: SubagentDeps): Promise<string> {
  deps.write("\n[子代理开始]\n");
  const sub = new Session(deps.systemPrompt, deps.model);
  sub.mode = deps.mode;
  sub.addUser(deps.task);
  await deps.runTurn({
    session: sub,
    config: deps.config,
    registry: deps.registry,
    ctx: { ...deps.ctx, subagentDepth: (deps.ctx.subagentDepth ?? 0) + 1 },
    gate: deps.gate,
    streamChat: deps.streamChat,
    executeToolCalls: deps.executeToolCalls,
    write: deps.write,
  });
  deps.write("\n[子代理完成]\n");
  const last = sub.messages[sub.messages.length - 1];
  return last && last.role === "assistant" && typeof last.content === "string" && last.content
    ? last.content
    : "(子代理无最终输出)";
}
```

- [ ] **Step 4:** `npx vitest run src/agent/subagent.test.ts` — 4 PASS。
- [ ] **Step 5:** `npx tsc --noEmit` — clean。
- [ ] **Step 6:** 提交
```bash
cd /Users/huaruoxu/ClaudeProject/career_plan/code/codeds
git add src/agent/subagent.ts src/agent/subagent.test.ts
git commit -m "feat(agent): one-shot subagent runner over an isolated session"
```

---

## Task 2: ToolContext 扩展 + agent 工具

**Files:** Modify `src/tools/types.ts`; Create `src/tools/agent.ts`, Test `src/tools/agent.test.ts`

**契约:** `ToolContext` 加可选 `runSubagent?: (task: string) => Promise<string>` 与 `subagentDepth?: number`。`agent` 工具参数 `{ task: string(非空) }`:`subagentDepth ≥ 1` → 拒绝"子代理内不能再派发子代理(防止递归)";无 `runSubagent` → "当前环境不支持子代理";否则 `return ctx.runSubagent(task)`。capability "plan"(plan 模式可用;子代理继承 plan 只读),approval "auto"。

- [ ] **Step 1: 改 `src/tools/types.ts` 的 `ToolContext`** —— 在现有可选字段后追加:
```ts
  // 一次性派发子代理,返回其最终结果(index 注入)。
  runSubagent?: (task: string) => Promise<string>;
  // 子代理嵌套深度(防递归);主 agent 为 0/undefined,子代理内为 1。
  subagentDepth?: number;
```
(其余 ToolContext 字段不变。)

- [ ] **Step 2: 失败测试 `src/tools/agent.test.ts`(EXACT)**
```ts
import { describe, it, expect } from "vitest";
import { agentTool } from "./agent.js";

describe("agent tool", () => {
  it("delegates the task to ctx.runSubagent and returns its result", async () => {
    let got = "";
    const out = await agentTool.handler(
      { task: "investigate the build" },
      { workspaceRoot: "/tmp", runSubagent: async (t) => { got = t; return "RESULT"; } },
    );
    expect(got).toBe("investigate the build");
    expect(out).toBe("RESULT");
  });

  it("refuses recursion when subagentDepth >= 1", async () => {
    let called = false;
    const out = await agentTool.handler(
      { task: "x" },
      { workspaceRoot: "/tmp", subagentDepth: 1, runSubagent: async () => { called = true; return "nope"; } },
    );
    expect(out).toContain("递归");
    expect(called).toBe(false);
  });

  it("errors when runSubagent is not configured", async () => {
    const out = await agentTool.handler({ task: "x" }, { workspaceRoot: "/tmp" });
    expect(out).toContain("不支持");
  });

  it("declares plan capability and auto approval", () => {
    expect(agentTool.capability).toBe("plan");
    expect(agentTool.approval).toBe("auto");
    expect(agentTool.name).toBe("agent");
  });
});
```

- [ ] **Step 3:** `npx vitest run src/tools/agent.test.ts` — FAIL。

- [ ] **Step 4: 写 `src/tools/agent.ts`(EXACT)**
```ts
import { z } from "zod";
import { defineTool } from "./types.js";

export const agentTool = defineTool({
  name: "agent",
  description:
    "把一个独立的子任务一次性派发给子代理:它用同样的工具自主跑完,只返回最终结果(你看不到它的中间过程)。适合可独立完成的调查或实现。任务描述要自包含——子代理没有当前对话上下文。",
  capability: "plan",
  approval: "auto",
  schema: z.object({
    task: z.string().min(1).describe("交给子代理的完整、自包含的任务描述"),
  }),
  handler: async (args, ctx) => {
    if ((ctx.subagentDepth ?? 0) >= 1) {
      return "子代理内不能再派发子代理(防止递归)。请自己完成或拆小任务。";
    }
    if (!ctx.runSubagent) {
      return "当前环境不支持子代理。";
    }
    return ctx.runSubagent(args.task);
  },
});
```

- [ ] **Step 5:** `npx vitest run src/tools/agent.test.ts` — 4 PASS。
- [ ] **Step 6:** `npx tsc --noEmit` — clean(`runSubagent?`/`subagentDepth?` 可选,不破坏现有 ctx 字面量)。
- [ ] **Step 7:** 提交
```bash
git add src/tools/types.ts src/tools/agent.ts src/tools/agent.test.ts
git commit -m "feat(tools): agent tool (one-shot dispatch via ctx.runSubagent, recursion guard)"
```

---

## Task 3: 装配 index(构建 ctx.runSubagent + 注册 agent)+ 全量验收

**Files:** Modify `src/index.ts`

- [ ] **Step 1: 改 `src/index.ts`** ——
  (a) 顶部 import 增加:
```ts
import { runSubagent } from "./agent/subagent.js";
import { agentTool } from "./tools/agent.js";
```
  (b) 工具注册数组里追加 `agentTool`(在 `memoryWriteTool` 之后):
```ts
    ..., webSearchTool, todoWriteTool, memoryWriteTool, agentTool,
```
  (c) 在 `ctx` 定义之后(`ctx` 已含 workspaceRoot/readFiles/ask/fetchImpl),**赋值 `ctx.runSubagent`**(闭包,复用主 systemPrompt + 当前 session.model/mode + 同一 registry/gate/streamChat/executeToolCalls/write/runTurn):
```ts
  ctx.runSubagent = (task: string) =>
    runSubagent({
      task,
      systemPrompt,
      model: session.model,
      mode: session.mode,
      config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
      registry,
      ctx,
      gate,
      streamChat,
      executeToolCalls,
      write,
      runTurn,
    });
```
  (注意:`ctx` 在闭包里被自身引用 —— `runSubagent` 内部 `{...deps.ctx, subagentDepth+1}`;`ctx` 是同一对象,合法(惰性,调用时已就绪)。`ctx` 用 `const` 声明但给可选属性赋值合法。其余 index 不变。)

- [ ] **Step 2: 全量 typecheck** —— `npx tsc --noEmit`,退出 0。
- [ ] **Step 3: 全量测试** —— `npx vitest run`,全 PASS。预期新增:agent/subagent(4)、tools/agent(4);在 M7 的 156 基础上 ≈ **~164 用例**。报实际总数。
- [ ] **Step 4: 无网络冒烟** ——
  `DEEPSEEK_API_KEY= npm run dev -- "hi"` → 含 "Missing DEEPSEEK_API_KEY",退出 1。
  REPL 命令:`printf '/help\n/exit\n' | DEEPSEEK_API_KEY=x npm run dev` → banner/help/再见,退出 0。
- [ ] **Step 5:** 提交
```bash
cd /Users/huaruoxu/ClaudeProject/career_plan/code/codeds
git add src/index.ts
git commit -m "feat: wire ctx.runSubagent and register agent tool (15 tools)"
```

---

## Task 4: 真网络/端到端验收(主 agent 派子代理)

> key 桥接,不回显。**由 controller 执行。** 任务设计成子代理只用只读 auto 工具(read_file/list_dir),避免审批管道。

- [ ] **Step 1: 主 agent 派子代理做独立调查** ——
```bash
set -a && . ./.env && set +a && DEEPSEEK_API_KEY="$DS_API_KEY" npm run dev -- "用 agent 工具派一个子代理:让它读取 package.json,告诉我这个项目的 name 字段和有哪些 npm scripts。把子代理的结论转达给我" 2>&1; echo "---EXIT=$?---"
```
Expected:主 agent 出现 `→ agent`,随后 `[子代理开始]` … 子代理自己的 `→ read_file`(只读 auto,无审批)… `[子代理完成]`;主 agent 拿到子代理的最终结果文本、转达项目 name(codeds)与 scripts(dev/test/typecheck 等)。退出 0。验证:一次性派发、子代理隔离上下文自跑、最终结果回传主 agent。

- [ ] **Step 2: (可选)防递归现象** —— 若想看防递归,可让子代理任务里要求它"再派一个子代理":子代理调 agent 工具会得到"子代理内不能再派发子代理"。非必须,单测已覆盖。

- [ ] **Step 3: 记录结论** —— 把 M8 验收结果一句话追加到设计文档 §6 末尾(agent 工具一次性派发、上下文隔离、最终结果回传、防递归实测/单测)。提交:
```bash
git add docs/architecture/overview.md
git commit -m "docs: record M8 subagent acceptance"
```

---

## 验收标准(M8 完成的定义)

- [ ] `npx vitest run` 全绿(约 164 用例)。
- [ ] `npx tsc --noEmit` 零错。
- [ ] 缺 key / REPL 命令冒烟正常。
- [ ] runSubagent:全新隔离会话(只 system+task)、返回最终 assistant 文本、subagentDepth+1、继承 mode、无输出占位(有测试)。
- [ ] agent 工具:委托 ctx.runSubagent、depth≥1 拒绝递归、无 runSubagent 报不支持、capability plan/approval auto(有测试)。
- [ ] index:ctx.runSubagent 闭包复用主 systemPrompt + session.model/mode + 同一 gate/registry;agent 注册为第 15 个工具。
- [ ] 真网络:主 agent 派子代理做独立调查、子代理自跑、最终结果回传主 agent(主 agent 上下文只收结果)。

## 给后续里程碑留的 carry-over

- **完成事件 → todo_write**:本 P1 靠"最终结果作工具消息",主 agent 自行更新 todo;无独立事件通道,够用。
- **子代理可见度**:现把子代理流式全渲染给用户(带标记);M9 富 TUI 可折叠/摘要展示子代理过程。
- **子代理模型选择**:现继承 session.model;可让调查类子代理默认用 flash 省钱(类似摘要)。
- **并行多子代理**:一轮多个 agent tool_call 由并发执行器支持,但各自内部串行;够用。
- **持久子会话**(open/eval/close)按 §2 决策不做。
- **M2–M7 旧 carry-over** 仍在(富 TUI→M9、项目指令文件加载、记忆 P2/P3、edit_file 越界测试、执行器并发回归测试、approval 三档、web_search 健壮性、注册顺序断言、§10 注入一次集成测试、compaction 端到端测试、摘要/子代理用 flash 省钱)。
- 下一步:M9 TUI(markdown 渲染、CJK 宽度、审批/REPL/子代理的更好交互)—— MVP 最后一块。