# 子代理对齐 CC · Part A(派发/注册表)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 把 DAO 子代理的**派发参数(调用级 model/mode 覆盖)**与**类型注册表(内置 general-purpose/plan、排除式 tools、默认 general-purpose)**对齐 CC,并把嵌套放开到一层——全程不引入破坏前缀缓存的 bug。

**Architecture:** 先把 `runSubagent` 从 6+ 位置参重构成 options 对象(无行为变化)打好地基;再依次加 registry 排除能力 → agent_defs 排除式解析 → 内置类型 + 默认 general-purpose + model/mode 解析 → agent 工具 schema 的 model/mode 入参与 fork 护栏 → 嵌套深度与深度感知并发 → 缓存安全/集成测试。

**Tech Stack:** TypeScript ESM(`.js` import 后缀)、Zod schema、Vitest。单测 `npx vitest run <file>`;`npm run typecheck`;`npm run lint`(0 error);全量 `npm test`。

参见 spec:`docs/design/specs/2026-06-17-subagent-cc-parity-design.md`。本计划只覆盖 Part A;Part B(双向事件驱动通信)另出计划。

---

## File Structure
| 文件 | 职责 | 改动 |
|---|---|---|
| `src/tools/types.ts` | `ToolContext.runSubagent` 签名 → options 对象(含 model/mode) | 改类型 |
| `src/index.ts` | runSubagent 实现改 options;默认 general-purpose;解析 model/mode;runBackgroundAgent 调用改 options | 改 |
| `src/tools/registry.ts` | 加"全集减排除"`subsetExcluding` | 加方法 |
| `src/agent/agent_defs.ts` | `tools` 解析 `*` 与 `!tool` → `tools`(include)+ `toolsExclude` | 改 |
| `src/agent/bundled_agents.ts` | 新增 `general-purpose`、`plan` | 加数据 |
| `src/tools/agent.ts` | schema 加 `model`/`mode`;fork 与 model/mode 互斥护栏;嵌套阈值→2;深度感知并发;调用改 options | 改 |
| 测试 | 各任务对应单测 + `cache_prefix` 风格缓存断言 | 加 |

---

## Task 1: 把 `runSubagent` 重构为 options 对象(无行为变化,打地基)

**Files:** Modify `src/tools/types.ts`、`src/index.ts`、`src/tools/agent.ts`;Test `src/agent/subagent.test.ts`(既有,须仍绿)。

- [ ] **Step 1: 改签名** — `src/tools/types.ts` 顶部确保有 `import type { Mode } from "./tools_for_mode.js";`,把 `runSubagent`(当前 24-31 行)替换为:

```ts
  runSubagent?: (opts: {
    task: string;
    signal?: AbortSignal;
    agentType?: string;
    workspaceRoot?: string;
    drainPending?: () => string[];
    auditAgent?: "sub" | "bg"; // 缓存审计身份:后台传 "bg",前台/工具默认 "sub"
    model?: string;            // 调用级模型覆盖(Task 5 起用);优先级最高
    mode?: Mode;               // 调用级权限模式覆盖(Task 5 起用)
  }) => Promise<string>;
```

- [ ] **Step 2: 改实现** — `src/index.ts:585` 的 `ctx.runSubagent = (task, signal?, agentType?, wsRoot?, drainPending?, auditAgent="sub") => {` 改为:

```ts
  ctx.runSubagent = ({ task, signal, agentType, workspaceRoot: wsRoot, drainPending, auditAgent = "sub" }) => {
```
> 函数体内原用 `task/signal/agentType/wsRoot/drainPending/auditAgent` 的引用保持不变(变量名一致)。本 Task 暂不读 model/mode。

- [ ] **Step 3: 改 runBackgroundAgent 调用** — `src/index.ts:636-638` 改为:

```ts
  ctx.runBackgroundAgent = (task: string, agentType?: string) =>
    taskManager.launch(`${agentType ? `[${agentType}] ` : ""}${task.slice(0, 50)}`, (signal, id) =>
      ctx.runSubagent!({ task, signal, agentType, drainPending: () => taskManager.drainPending(id), auditAgent: "bg" }),
    );
```

- [ ] **Step 4: 改 agent 工具内调用** — `src/tools/agent.ts`:把 `const run = ctx.runSubagent;`(57 行)后所有 `run(...)` 改 options 形式:
  - 66 行 `const r = await run(t, ctx.signal, type, wt.root);` → `const r = await run({ task: t, signal: ctx.signal, agentType: type, workspaceRoot: wt.root });`
  - 73 行 `return run(t, ctx.signal, type);` → `return run({ task: t, signal: ctx.signal, agentType: type });`
  - 79 行 `const p = run(tasks[0]!, ctx.signal, type);` → `const p = run({ task: tasks[0]!, signal: ctx.signal, agentType: type });`

- [ ] **Step 5: 跑确认无回归** — `npx vitest run src/agent/subagent.test.ts` · `npm run typecheck`。预期:全绿(纯重构)。

- [ ] **Step 6: 提交**
```bash
git add src/tools/types.ts src/index.ts src/tools/agent.ts
git commit -m "refactor(agent): runSubagent 改 options 对象(为 model/mode 覆盖打地基,无行为变化)"
```

---

## Task 2: registry —— "全集减排除" `subsetExcluding`

**Files:** Modify `src/tools/registry.ts`;Test `src/tools/registry.test.ts`(无则新建)。

- [ ] **Step 1: 写失败测试** — 新建/追加 `src/tools/registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ToolRegistry } from "./registry.js";
import { z } from "zod";

const mk = (name: string) => ({ name, description: name, schema: z.object({}), handler: async () => "" });

describe("ToolRegistry.subsetExcluding", () => {
  it("保留除排除名外的全部工具,维持插入顺序", () => {
    const r = new ToolRegistry();
    ["a", "b", "c", "d"].forEach((n) => r.register(mk(n)));
    const sub = r.subsetExcluding(new Set(["b", "d"]));
    expect(sub.get("a")).toBeDefined();
    expect(sub.get("c")).toBeDefined();
    expect(sub.get("b")).toBeUndefined();
    expect(sub.get("d")).toBeUndefined();
    expect(sub.toApiTools().map((t) => t.function.name)).toEqual(["a", "c"]);
  });
  it("排除空集 → 全保留", () => {
    const r = new ToolRegistry();
    ["a", "b"].forEach((n) => r.register(mk(n)));
    expect(r.subsetExcluding(new Set()).toApiTools()).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 跑确认失败** — `npx vitest run src/tools/registry.test.ts`(`subsetExcluding` 未定义)。

- [ ] **Step 3: 实现** — `src/tools/registry.ts` 在 `subset` 方法后加:

```ts
  // 按排除名建子集(自定义 agent 的 "*, !tool" 排除式用);保持插入顺序。
  subsetExcluding(names: Set<string>): ToolRegistry {
    const r = new ToolRegistry();
    for (const [n, t] of this.tools) if (!names.has(n)) r.register(t);
    return r;
  }
```

- [ ] **Step 4: 跑确认通过** — `npx vitest run src/tools/registry.test.ts` · `npm run typecheck`。

- [ ] **Step 5: 提交**
```bash
git add src/tools/registry.ts src/tools/registry.test.ts
git commit -m "feat(agent): ToolRegistry.subsetExcluding——排除式工具白名单基础"
```

---

## Task 3: agent_defs —— 解析 `*` 与 `!tool` 排除式

**Files:** Modify `src/agent/agent_defs.ts`;Test `src/agent/agent_defs.test.ts`(无则新建)。

- [ ] **Step 1: 写失败测试** — 追加/新建 `src/agent/agent_defs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseAgentDef } from "./agent_defs.js";

const md = (tools: string) => `---\nname: t\ndescription: d\ntools: ${tools}\n---\n正文`;

describe("parseAgentDef tools 解析", () => {
  it("纯列举 → include 列表(兼容旧行为)", () => {
    const d = parseAgentDef("t", md("read_file, grep_files"))!;
    expect(d.tools).toEqual(["read_file", "grep_files"]);
    expect(d.toolsExclude).toBeUndefined();
  });
  it("'*, !x, !y' → 全集 + 排除", () => {
    const d = parseAgentDef("t", md("*, !edit_file, !write_file"))!;
    expect(d.tools).toBeUndefined(); // 全集
    expect(d.toolsExclude).toEqual(["edit_file", "write_file"]);
  });
  it("只有排除项(无 *)也按全集减排除处理", () => {
    const d = parseAgentDef("t", md("!exec_shell"))!;
    expect(d.tools).toBeUndefined();
    expect(d.toolsExclude).toEqual(["exec_shell"]);
  });
  it("无 tools 字段 → 都为 undefined(继承全部)", () => {
    const d = parseAgentDef("t", `---\nname: t\ndescription: d\n---\n正文`)!;
    expect(d.tools).toBeUndefined();
    expect(d.toolsExclude).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑确认失败** — `npx vitest run src/agent/agent_defs.test.ts`(`toolsExclude` 不存在 / 解析未实现)。

- [ ] **Step 3: 实现** — `src/agent/agent_defs.ts`:
  - `AgentDef` 接口(8-14 行)的 `tools?: string[];` 后加一行:
```ts
  toolsExclude?: string[]; // "*, !x" 语法的排除名;tools=undefined 表示全集,再减去这些
```
  - 替换 `parseAgentDef`(27-39 行)里构造 tools 的部分。原:
```ts
  const toolsRaw = fm.tools ?? fm["allowed-tools"] ?? fm.allowedtools;
  return {
    name,
    description: fm.description ?? "",
    tools: toolsRaw ? toolsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    model: fm.model || undefined,
    prompt: body,
  };
```
  改为:
```ts
  const toolsRaw = fm.tools ?? fm["allowed-tools"] ?? fm.allowedtools;
  const tokens = toolsRaw ? toolsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const exclude = tokens.filter((t) => t.startsWith("!")).map((t) => t.slice(1).trim()).filter(Boolean);
  const include = tokens.filter((t) => t !== "*" && !t.startsWith("!"));
  const hasStar = tokens.includes("*");
  // include 非空且无 * → 白名单;否则(含 * 或仅排除项或空)→ 全集(undefined)再减 exclude。
  const tools = include.length > 0 && !hasStar ? include : undefined;
  return {
    name,
    description: fm.description ?? "",
    tools,
    toolsExclude: exclude.length > 0 ? exclude : undefined,
    model: fm.model || undefined,
    prompt: body,
  };
```

- [ ] **Step 4: 跑确认通过** — `npx vitest run src/agent/agent_defs.test.ts` · `npm run typecheck`。

- [ ] **Step 5: 提交**
```bash
git add src/agent/agent_defs.ts src/agent/agent_defs.test.ts
git commit -m "feat(agent): agent_defs 解析 '*, !tool' 排除式 tools(tools+toolsExclude)"
```

---

## Task 4: 内置 general-purpose/plan + 默认 general-purpose + model/mode 解析

**Files:** Modify `src/agent/bundled_agents.ts`、`src/index.ts`;Test `src/agent/bundled_agents.test.ts`(新建)。

- [ ] **Step 1: 写失败测试** — 新建 `src/agent/bundled_agents.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { BUNDLED_AGENTS } from "./bundled_agents.js";

describe("BUNDLED_AGENTS", () => {
  it("含 general-purpose(全工具、模型跟随会话=未设)", () => {
    const g = BUNDLED_AGENTS.find((a) => a.name === "general-purpose")!;
    expect(g).toBeDefined();
    expect(g.tools).toBeUndefined();       // 继承全部工具
    expect(g.toolsExclude).toBeUndefined();
    expect(g.model).toBeUndefined();       // 跟随主会话模型(默认 pro)
    expect(g.prompt.length).toBeGreaterThan(20);
  });
  it("含 plan(只读+设计:排除写/执行类工具)", () => {
    const p = BUNDLED_AGENTS.find((a) => a.name === "plan")!;
    expect(p.tools).toBeUndefined();
    expect(new Set(p.toolsExclude)).toEqual(new Set([
      "edit_file", "write_file", "multi_edit", "notebook_edit",
      "exec_shell", "exec_shell_poll", "exec_shell_kill",
    ]));
    expect(p.model).toBeUndefined(); // 规划要强推理 → 跟随会话(pro)
  });
});
```

- [ ] **Step 2: 跑确认失败** — `npx vitest run src/agent/bundled_agents.test.ts`。

- [ ] **Step 3: 实现内置类型** — `src/agent/bundled_agents.ts` 的 `BUNDLED_AGENTS` 数组**追加**两项(放在 explore/verify 之后):

```ts
  {
    name: "general-purpose",
    description: "通用子代理:自包含地完成一件被交代清楚的子任务,用同样的工具自主跑完、只回提炼后的结论。省略 agent_type 时默认用它。",
    // model 不设 → 跟随主会话模型(默认 pro);tools 不设 → 继承全部工具。
    prompt: `你是通用子代理(general-purpose)。你被派来独立完成一件子任务——你没有主对话的上下文,任务描述即你拥有的全部背景。
- 自包含完成:用你拥有的工具把这件事做完,不要반问、不要假设主任务的其它状态。
- 只回结论:返回提炼后的最终结果(做了什么、结论是什么、关键证据 file:line),不要把中间过程或整块文件倒回去。
- 不确定就说不确定,别编。`,
  },
  {
    name: "plan",
    description: "架构规划子代理:只读分析代码库后产出实现思路/步骤/取舍与关键文件,不改任何文件、不执行命令。",
    // 规划要强推理 → model 不设,跟随会话(pro)。排除写类与执行类工具(只读+设计)。
    toolsExclude: ["edit_file", "write_file", "multi_edit", "notebook_edit", "exec_shell", "exec_shell_poll", "exec_shell_kill"],
    prompt: `你是规划子代理(plan)。职责:读懂相关代码后给出**实现方案**——步骤拆解、关键文件与改动点、架构取舍与风险,不写代码、不执行命令。
- 只读取证:用 read_file/grep_files/file_search/list_dir 把现状摸清,再设计。
- 产出可执行的计划:每步说清动哪个文件、为什么;指出依赖与顺序;标出不确定处与备选。
- 不改文件、不跑命令(你没有写/执行工具)。`,
  },
```
> 注意 `bundled_agents.ts` 的 `AgentDef` 已含 `toolsExclude`(Task 3 加)。`general-purpose` 不写 toolsExclude/tools/model。修正:上面 prompt 里的全角字符"반问"应为"反问",录入时写成 `不要反问`。

- [ ] **Step 4: 默认 general-purpose + model/mode 解析 + 排除式 tools** — `src/index.ts` 的 `ctx.runSubagent`(Task 1 改成 options 后)函数体,把原 586-588 行:
```ts
    const def = agentType ? agentDefs.find((d) => d.name === agentType) : undefined;
    const sp = def ? `${systemPrompt}\n\n# 你的专用角色(${def.name})\n${def.prompt}` : systemPrompt;
    const reg = def?.tools ? registry.subset(new Set(def.tools)) : registry;
```
  改为(默认 general-purpose;include 子集→再减 exclude;model/mode 解析):
```ts
    // 省略 agent_type 时默认用 general-purpose(对齐 CC);找不到该内置则回退裸 systemPrompt。
    const def = agentDefs.find((d) => d.name === (agentType ?? "general-purpose"));
    const sp = def ? `${systemPrompt}\n\n# 你的专用角色(${def.name})\n${def.prompt}` : systemPrompt;
    let reg = def?.tools ? registry.subset(new Set(def.tools)) : registry;
    if (def?.toolsExclude?.length) reg = reg.subsetExcluding(new Set(def.toolsExclude));
    const subModel = model ?? def?.model ?? session.model;     // 优先级:调用级 > 类型 > 会话
    const subMode = mode ?? session.mode;
```
  且把 `ctx.runSubagent = ({ task, signal, agentType, workspaceRoot: wsRoot, drainPending, auditAgent = "sub" }) =>` 的解构补上 `model, mode`:
```ts
  ctx.runSubagent = ({ task, signal, agentType, workspaceRoot: wsRoot, drainPending, auditAgent = "sub", model, mode }) => {
```
  并把传给 `runSubagent({...})`(index.ts ~592-594)的 `model`/`mode` 字段改用解析值:
```ts
      systemPrompt: sp,
      model: subModel,
      mode: subMode,
```
> `registry` 在此闭包内是常量;改为 `let reg` 后下方用 `registry: reg` 不变。`session` 在闭包可见(用于 `session.model`/`session.mode`)。

- [ ] **Step 5: 跑确认通过 + 不回归** — `npx vitest run src/agent/bundled_agents.test.ts src/agent/subagent.test.ts` · `npm run typecheck`。

- [ ] **Step 6: 提交**
```bash
git add src/agent/bundled_agents.ts src/agent/bundled_agents.test.ts src/index.ts
git commit -m "feat(agent): 内置 general-purpose/plan + 省略 type 默认 general-purpose + model/mode 解析 + 排除式 tools 接线"
```

---

## Task 5: agent 工具 schema —— model/mode 入参 + fork 互斥护栏 + 透传

**Files:** Modify `src/tools/agent.ts`;Test `src/tools/agent.test.ts`(无则新建)。

- [ ] **Step 1: 写失败测试** — 追加/新建 `src/tools/agent.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { agentTool } from "./agent.js";

// 最小 ctx:记录 runSubagent 收到的 opts。
function mkCtx(over: Record<string, unknown> = {}) {
  const calls: any[] = [];
  return {
    calls,
    ctx: {
      workspaceRoot: "/tmp",
      readFiles: new Set<string>(),
      subagentDepth: 0,
      agentTypes: [{ name: "explore", description: "" }],
      runSubagent: async (opts: any) => { calls.push(opts); return "OK"; },
      ...over,
    } as any,
  };
}

describe("agent 工具 model/mode/fork 护栏", () => {
  it("model/mode 透传进 runSubagent opts", async () => {
    const { ctx, calls } = mkCtx();
    await agentTool.handler({ task: "do x", model: "deepseek-v4-flash", mode: "plan" } as any, ctx);
    expect(calls[0]).toMatchObject({ model: "deepseek-v4-flash", mode: "plan" });
  });
  it("fork + model → 拒绝(跨模型丢缓存)", async () => {
    const { ctx, calls } = mkCtx({ runForkAgent: async () => "F" });
    const r = await agentTool.handler({ task: "x", fork: true, model: "deepseek-v4-flash" } as any, ctx);
    expect(r).toContain("fork");
    expect(calls).toHaveLength(0); // 没真派
  });
  it("fork + mode → 拒绝", async () => {
    const { ctx } = mkCtx({ runForkAgent: async () => "F" });
    const r = await agentTool.handler({ task: "x", fork: true, mode: "plan" } as any, ctx);
    expect(r).toContain("fork");
  });
});
```

- [ ] **Step 2: 跑确认失败** — `npx vitest run src/tools/agent.test.ts`。

- [ ] **Step 3: 实现 schema** — `src/tools/agent.ts` 顶部加 `import { z } from "zod";`(已有)。在 `schema: z.object({...})` 内 `fork` 字段后加:

```ts
    model: z
      .string()
      .optional()
      .describe("调用级模型覆盖(如 deepseek-v4-flash 省钱跑廉价子任务)。注意:换模型会让前缀缓存失效——只在任务足够廉价时才划算。与 fork 互斥。"),
    mode: z
      .enum(["normal", "plan"])
      .optional()
      .describe("调用级权限模式覆盖:plan=只读规划。省略则继承主会话模式。与 fork 互斥。"),
```

- [ ] **Step 4: 实现 fork 护栏 + 透传** — `src/tools/agent.ts` handler 内,在 `const fork = !!args.fork && !!ctx.runForkAgent;`(58 行)**之前**加护栏(用 `args.fork` 判,早返回):

```ts
    if (args.fork && (args.model || args.mode)) {
      return "fork 与 model/mode 覆盖互斥:fork 的价值是复用父代理的前缀缓存,而换模型/改模式会让该缓存失效、fork 失去意义。请去掉 model/mode,或改用普通子代理(去掉 fork)。";
    }
```
  然后把 Task 1 改过的三处 options 调用补上 model/mode(从 args 取):
  - isolate 路径:`run({ task: t, signal: ctx.signal, agentType: type, workspaceRoot: wt.root, model: args.model, mode: args.mode })`
  - 普通路径:`run({ task: t, signal: ctx.signal, agentType: type, model: args.model, mode: args.mode })`
  - 单任务 adopt 路径(79 行):`run({ task: tasks[0]!, signal: ctx.signal, agentType: type, model: args.model, mode: args.mode })`
> 后台路径(51-56 行 `runBackgroundAgent`)本 Task 不传 model/mode(runBackgroundAgent 签名未带;留 Part B 或后续;此处保持原样,后台子代理用类型/会话默认模型)。

- [ ] **Step 5: 跑确认通过** — `npx vitest run src/tools/agent.test.ts` · `npm run typecheck`。

- [ ] **Step 6: 提交**
```bash
git add src/tools/agent.ts src/tools/agent.test.ts
git commit -m "feat(agent): agent 工具加 model/mode 覆盖 + fork 互斥护栏(防跨模型丢缓存)"
```

---

## Task 6: 嵌套放到一层 + 超限优雅拒绝 + 深度感知并发

**Files:** Modify `src/tools/agent.ts`;Test 追加到 `src/tools/agent.test.ts`。

- [ ] **Step 1: 写失败测试** — 追加:

```ts
describe("agent 嵌套深度与并发", () => {
  it("depth 1(子代理内)仍可派 → 允许一层", async () => {
    const { ctx, calls } = mkCtx({ subagentDepth: 1 });
    const r = await agentTool.handler({ task: "x" } as any, ctx);
    expect(calls).toHaveLength(1);
    expect(r).toBe("OK");
  });
  it("depth 2 → 拒绝并说明", async () => {
    const { ctx, calls } = mkCtx({ subagentDepth: 2 });
    const r = await agentTool.handler({ task: "x" } as any, ctx);
    expect(calls).toHaveLength(0);
    expect(r).toContain("嵌套上限");
  });
});
```

- [ ] **Step 2: 跑确认失败** — `npx vitest run src/tools/agent.test.ts`(depth1 现在被旧 `>=1` 拒)。

- [ ] **Step 3: 实现** — `src/tools/agent.ts`:
  - 把 `if ((ctx.subagentDepth ?? 0) >= 1) { return "子代理内不能再派发子代理(防止递归)。请自己完成或拆小任务。"; }`(39-41 行)改为:
```ts
    if ((ctx.subagentDepth ?? 0) >= 2) {
      return "已达子代理嵌套上限(2 层):为防递归放大与成本失控,这一层不能再派子代理。请自己完成这件事,或把它拆小后在结论里回报需要继续的部分。";
    }
```
  - 把并发常量(93 行)`const MAX_PARALLEL = Number(process.env.DAO_MAX_PARALLEL_AGENTS) || 10;` 改为深度感知:
```ts
    // 深度感知并发:depth1 子代理再扇出(→depth2)时收紧到 3,避免 10×10 指数爆;主代理(depth0)用默认 10。
    const depth = ctx.subagentDepth ?? 0;
    const MAX_PARALLEL = depth >= 1 ? 3 : (Number(process.env.DAO_MAX_PARALLEL_AGENTS) || 10);
```

- [ ] **Step 4: 跑确认通过** — `npx vitest run src/tools/agent.test.ts` · `npm run typecheck`。

- [ ] **Step 5: 提交**
```bash
git add src/tools/agent.ts src/tools/agent.test.ts
git commit -m "feat(agent): 嵌套放到一层(depth<2)+ 超限优雅拒绝 + 深度感知并发(depth2≤3)"
```

---

## Task 7: 缓存安全 + 集成回归

**Files:** Test `src/agent/subagent.test.ts`(追加)。

- [ ] **Step 1: 写测试** — 验证 Part A 没破坏缓存纪律与 fork 语义。追加到 `src/agent/subagent.test.ts`(参考其现有 deps 构造方式):

```ts
import { describe, it, expect } from "vitest";
// 复用文件已有的 runSubagent / fake deps 构造;若没有,仿 cache_prefix.test.ts 的 deps()。

describe("Part A 缓存安全", () => {
  it("fork 路径仍 byte-identical 复用父前缀(默认 general-purpose 不污染 fork)", async () => {
    // fork 走 runForkAgent(继承父 messages 前缀),不应被 general-purpose 默认改写。
    // 断言:fork 子会话的 messages[0..n-1] 与父前缀逐条相等,只末尾多一条子任务 user 消息。
    // (按本仓库 fork 测试惯例补全:构造父 messages,跑 fork,比对前缀。)
    expect(true).toBe(true); // 占位:实现者按仓库 fork 测试惯例落实前缀 byte 相等断言
  });
});
```
> 说明:本仓库 fork 的可测接口以 `runForkAgent`/`forkMessages` 为准(`subagent.ts:37-40`)。实现者读 `src/agent/cache_prefix.test.ts` 与现有 `subagent.test.ts`,按同样的 fake `runTurn`/`Session` 构造,落实"fork 子会话前缀与父逐条相等、仅尾部追加一条"的断言;并加一条"普通子代理用 model 覆盖时建自己独立前缀、不触碰父 session.messages"的断言。**禁止留占位 `expect(true)`——必须是真断言。**

- [ ] **Step 2: 跑确认** — `npx vitest run src/agent/subagent.test.ts`。

- [ ] **Step 3: 全量回归** — `npm test` · `npm run typecheck` · `npm run lint`(0 error)。

- [ ] **Step 4: 提交**
```bash
git add src/agent/subagent.test.ts
git commit -m "test(agent): Part A 缓存安全断言(fork 前缀 byte 相等 / model 覆盖独立前缀)"
```

---

## Self-Review(已执行)
**Spec 覆盖(Part A):** A1.①model→T4/T5;A1.②mode→T4/T5;A2.①内置类型→T4;A2.②排除式tools→T2/T3/T4;A2.③默认general-purpose→T4;A4嵌套→T6;运行时透传→T1/T4;缓存安全不变式→T5护栏(fork+model 拒)+T7断言。Out of scope(remote/并发数/C workflow)未纳入,符合 spec。
**占位符扫描:** 仅 T7 Step1 含一个显式标注的占位断言,并在说明里强制实现者替换为真断言(因 fork 前缀断言需按仓库既有 fake runTurn/Session 惯例落地,无法脱离上下文预写死)。其余步骤均有完整代码。
**类型一致性:** `runSubagent` options 形(task/signal/agentType/workspaceRoot/drainPending/auditAgent/model/mode)在 T1 定义,T4 解构 model/mode、T5 由 agent 工具填充,贯穿一致;`AgentDef.toolsExclude` 在 T3 定义、T4 消费;`subsetExcluding` T2 定义、T4 调用;`Mode`("normal"|"plan")在 schema(T5)与签名(T1)一致。
**已知前置:** T4 默认 general-purpose 依赖 T4 同任务新增的内置定义(同任务内闭环);T7 依赖仓库既有 fork 测试惯例(实现者须读 cache_prefix.test.ts / subagent.test.ts)。
