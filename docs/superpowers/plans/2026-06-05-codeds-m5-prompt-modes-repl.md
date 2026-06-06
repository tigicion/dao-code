# codeds M5 — 系统 prompt + 模式 + REPL + 斜杠命令 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把设计文档 §3 那份中文系统 prompt 真正接进 agent loop;加 **normal/plan 双模式**(plan 下只读+提方案,靠"把写/执行工具从工具表移除"来强制,而非靠 prompt 喊话);把 codeds 从一次性 CLI 升级成**交互式 REPL**(可多轮对话);加斜杠命令 **/model /plan /clear /help /exit**(`/compact` 留到 M7)。

**Architecture(关键决策,已与用户确认 2026-06-05):**
- **系统 prompt 会话启动时构建一次、固定不变**(messages[0] 永不重写)→ 前缀 cache 稳定(§10)。`/model` 只改请求里的 `model` 字段、不碰历史;prompt 里的 `{model_id}` 反映起始模型(切换后小幅 cosmetic 过时,可接受)。
- **plan 模式靠代码强制**:构建每轮工具表时按 mode 过滤——plan 下移除 `capability ∈ {write, exec}` 的工具,模型物理上调不到写/执行工具。**代码优先于 prompt**。
- **REPL + argv 一次性并存**:带 argv 提示词→跑一次退出(兼容现有验收脚本);无 argv→进交互会话。
- **单一 stdin**:REPL 读行、审批提示、ask_user 全部走同一个注入的 `ask(prompt): Promise<string>`(底层一个 readline),避免多 readline 抢 stdin。
- `Session` 持有 `messages / model / mode`,跨用户输入累积(只追加;`/clear` 重置回仅系统 prompt)。

**Tech Stack:** 沿用(Node20+/TS-ESM/vitest/zod);REPL 用 `node:readline/promises`。无新第三方依赖。

参考:设计文档 §3(系统 prompt 正文)、§8(模式)、§10(cache)、§11(prompt/session/commands 模块)。M4 代码(13 个工具)。

**范围与延后**:`/compact` 与上下文压缩(M7);子代理 prompt 段与 `agent` 工具(M8);富 TUI/markdown 渲染(M9);项目指令文件(`{project_instruction_files}`)M5 先填占位"(无)",真正加载留后续。approval 三档细分仍 carry-over。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/prompt/system_prompt.ts` | §3 prompt 正文 + 模式/规划/工具段 + 占位符填充 | 新建 |
| `src/tools/tools_for_mode.ts` | `Mode` 类型 + `apiToolsForMode`(plan 过滤写/执行) | 新建 |
| `src/tools/registry.ts` | `toApiTools` 支持可选 predicate 过滤 | 改 |
| `src/session/session.ts` | `Session`(messages/model/mode) | 新建 |
| `src/agent/loop.ts` | `runAgent`→`runTurn(session)` | 改 |
| `src/commands/commands.ts` | `dispatchCommand`(/model /plan /clear /help /exit /compact) | 新建 |
| `src/approval/stdin_prompt.ts` | 改为 `makeApprovalPrompt(ask)`(注入 ask) | 改 |
| `src/tools/stdin_ask.ts` | 删除(ctx.ask 由 index 用 ask 构建) | 删 |
| `src/repl.ts` | `runRepl`(可注入 readLine/runTurn,可测) | 新建 |
| `src/index.ts` | 单一 readline→ask;argv 一次性 vs REPL;组装 prompt/session/gate/ctx | 改 |

---

## Task 1: 系统 prompt 组装

**Files:** Create `src/prompt/system_prompt.ts`, Test `src/prompt/system_prompt.test.ts`

**契约:** `buildSystemPrompt({ modelId, toolSummaries, projectInstructions? }): string`。把 §3 正文 + 新增的「模式 / 任务规划 / 工具」三段拼成模板,替换 `{model_id}`、`{project_instruction_files}`(默认 `(无)`)、`{tools}`(传入的工具速查)。返回的字符串里不得残留 `{...}` 占位符。

- [ ] **Step 1: 失败测试 `src/prompt/system_prompt.test.ts`(EXACT)**
```ts
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./system_prompt.js";

describe("buildSystemPrompt", () => {
  const prompt = buildSystemPrompt({
    modelId: "deepseek-v4-pro",
    toolSummaries: "- read_file:读文件\n- write_file:写文件",
    projectInstructions: "(无)",
  });

  it("substitutes the model id", () => {
    expect(prompt).toContain("deepseek-v4-pro");
  });

  it("injects the tool summaries", () => {
    expect(prompt).toContain("- read_file:读文件");
    expect(prompt).toContain("- write_file:写文件");
  });

  it("describes the two modes", () => {
    expect(prompt).toContain("plan");
    expect(prompt).toMatch(/只读|提方案/);
  });

  it("leaves no unfilled placeholders", () => {
    expect(prompt).not.toMatch(/\{[a-z_]+\}/);
  });

  it("defaults project instructions to (无) when omitted", () => {
    const p2 = buildSystemPrompt({ modelId: "x", toolSummaries: "- a:b" });
    expect(p2).toContain("(无)");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/prompt/system_prompt.test.ts` — FAIL。

- [ ] **Step 3: 写 `src/prompt/system_prompt.ts`**
  把 **设计文档 `docs/2026-06-04-deepseek-coding-agent-design.md` §3 的 ```markdown 代码块正文**(从 `# 你是谁` 到 `# 回复风格` 整段,含其中的 `{model_id}` 与 `{project_instruction_files}` 占位符)**逐字复制**进一个 `const BODY` 模板字符串。然后在正文末尾**追加下面三段(EXACT)**,再写 `buildSystemPrompt`。最终文件结构如下(把 `__§3 正文逐字__` 替换为复制来的正文):
```ts
const BODY = `__§3 正文逐字(# 你是谁 … # 回复风格,保留 {model_id} 和 {project_instruction_files})__


# 模式

你有两种工作模式:
- normal:正常工作,可读可写可执行(写/执行类工具仍需用户审批)。
- plan:只读 + 提方案。此模式下你只能读取与搜索,不能修改文件或执行命令(相关工具已不可用);把调研结论与改动计划讲清楚,等用户说"开干"、切回 normal 再动手。
用户用 /plan 切换模式。不要在 plan 模式下假装已经改了东西。


# 任务规划

5 步以上、或涉及多文件、有先后依赖的任务,先用 todo_write 拆成单层清单,边做边更新状态(同一时刻只一个 in_progress)。简单任务不必拆。


# 工具

你手上的工具(按需果断使用,互不依赖的尽量并行):
{tools}

选择指南:读单个文件用 read_file;按名字找文件用 file_search;按内容搜用 grep_files;
新建/整体重写用 write_file,局部精确替换用 edit_file(改前先 read_file);
跑命令用 exec_shell(长任务加 background,再用 exec_shell_poll/exec_shell_kill);
联网搜索 web_search、抓网页 fetch_url;只有缺关键信息且无法用其它工具获取时,才用 ask_user 向用户提问。
`;

export interface SystemPromptOptions {
  modelId: string;
  toolSummaries: string; // 多行 "- name:描述"
  projectInstructions?: string;
}

export function buildSystemPrompt(opts: SystemPromptOptions): string {
  return BODY
    .replaceAll("{model_id}", opts.modelId)
    .replaceAll("{project_instruction_files}", opts.projectInstructions ?? "(无)")
    .replaceAll("{tools}", opts.toolSummaries);
}
```
> 注意:`BODY` 里只允许保留 `{model_id}`、`{project_instruction_files}`、`{tools}` 三个占位符;§3 正文中若有反引号 `` ` `` 或 `${` 需转义(模板字符串内)。复制后跑测试,第 4 个用例("无残留占位符")会帮你抓出漏填。

- [ ] **Step 4:** `npx vitest run src/prompt/system_prompt.test.ts` — 5 PASS。
- [ ] **Step 5:** `npx tsc --noEmit` — clean。
- [ ] **Step 6:** 提交
```bash
cd /Users/huaruoxu/ClaudeProject/career_plan/code/codeds
git add src/prompt/system_prompt.ts src/prompt/system_prompt.test.ts
git commit -m "feat(prompt): assemble system prompt with mode/planning/tools sections"
```

---

## Task 2: 模式感知工具表(registry 过滤 + apiToolsForMode)

**Files:** Modify `src/tools/registry.ts`; Create `src/tools/tools_for_mode.ts`, Test `src/tools/tools_for_mode.test.ts`

- [ ] **Step 1: 改 `src/tools/registry.ts` 的 `toApiTools`** 为支持可选过滤(其余不变):
```ts
  toApiTools(predicate?: (tool: Tool) => boolean): ApiTool[] {
    return [...this.tools.values()]
      .filter((t) => (predicate ? predicate(t) : true))
      .map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: toJsonSchema(t.schema),
        },
      }));
  }
```

- [ ] **Step 2: 失败测试 `src/tools/tools_for_mode.test.ts`(EXACT)**
```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { apiToolsForMode } from "./tools_for_mode.js";
import { ToolRegistry } from "./registry.js";
import { defineTool } from "./types.js";

function reg() {
  const r = new ToolRegistry();
  r.register(defineTool({ name: "read_file", description: "", capability: "read", approval: "auto", schema: z.object({}), handler: async () => "" }));
  r.register(defineTool({ name: "write_file", description: "", capability: "write", approval: "required", schema: z.object({}), handler: async () => "" }));
  r.register(defineTool({ name: "exec_shell", description: "", capability: "exec", approval: "required", schema: z.object({}), handler: async () => "" }));
  return r;
}

describe("apiToolsForMode", () => {
  it("returns all tools in normal mode", () => {
    const names = apiToolsForMode(reg(), "normal").map((t) => t.function.name);
    expect(names).toEqual(["read_file", "write_file", "exec_shell"]);
  });

  it("drops write/exec tools in plan mode", () => {
    const names = apiToolsForMode(reg(), "plan").map((t) => t.function.name);
    expect(names).toEqual(["read_file"]);
  });
});
```

- [ ] **Step 3:** `npx vitest run src/tools/tools_for_mode.test.ts` — FAIL。

- [ ] **Step 4: 写 `src/tools/tools_for_mode.ts`(EXACT)**
```ts
import type { ApiTool } from "../client/types.js";
import type { ToolRegistry } from "./registry.js";

export type Mode = "normal" | "plan";

// plan 模式下移除写/执行类工具(只读+提方案);normal 返回全部。
export function apiToolsForMode(registry: ToolRegistry, mode: Mode): ApiTool[] {
  if (mode === "normal") return registry.toApiTools();
  return registry.toApiTools((t) => t.capability !== "write" && t.capability !== "exec");
}
```

- [ ] **Step 5:** `npx vitest run src/tools/tools_for_mode.test.ts` — 2 PASS。
- [ ] **Step 6:** `npx tsc --noEmit` — clean(registry 现有测试不受影响,predicate 可选)。
- [ ] **Step 7:** 提交
```bash
git add src/tools/registry.ts src/tools/tools_for_mode.ts src/tools/tools_for_mode.test.ts
git commit -m "feat(tools): mode-aware tool list (plan drops write/exec)"
```

---

## Task 3: Session

**Files:** Create `src/session/session.ts`, Test `src/session/session.test.ts`

**契约:** `Session(systemPrompt, model)`:`messages` 以 `[{role:"system",content:systemPrompt}]` 起步,`model` 与 `mode("normal")` 可变。`addUser(text)` 追加 user 消息;`clear()` 重置 messages 回仅系统 prompt(丢弃对话);`setModel(m)` 改 model(不动 messages);`toggleMode()` 翻转并返回新 mode。

- [ ] **Step 1: 失败测试 `src/session/session.test.ts`(EXACT)**
```ts
import { describe, it, expect } from "vitest";
import { Session } from "./session.js";

describe("Session", () => {
  it("starts with the system prompt and given model", () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    expect(s.messages).toEqual([{ role: "system", content: "SYS" }]);
    expect(s.model).toBe("deepseek-v4-pro");
    expect(s.mode).toBe("normal");
  });

  it("appends user messages", () => {
    const s = new Session("SYS", "m");
    s.addUser("hi");
    expect(s.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
    ]);
  });

  it("clear resets to just the system prompt", () => {
    const s = new Session("SYS", "m");
    s.addUser("a");
    s.messages.push({ role: "assistant", content: "b" });
    s.clear();
    expect(s.messages).toEqual([{ role: "system", content: "SYS" }]);
  });

  it("setModel changes the model without touching messages", () => {
    const s = new Session("SYS", "m");
    s.addUser("a");
    s.setModel("deepseek-v4-flash");
    expect(s.model).toBe("deepseek-v4-flash");
    expect(s.messages).toHaveLength(2);
  });

  it("toggleMode flips between normal and plan", () => {
    const s = new Session("SYS", "m");
    expect(s.toggleMode()).toBe("plan");
    expect(s.mode).toBe("plan");
    expect(s.toggleMode()).toBe("normal");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/session/session.test.ts` — FAIL。

- [ ] **Step 3: 写 `src/session/session.ts`(EXACT)**
```ts
import type { ChatMessage } from "../client/types.js";
import type { Mode } from "../tools/tools_for_mode.js";

export class Session {
  messages: ChatMessage[];
  model: string;
  mode: Mode = "normal";
  private readonly systemPrompt: string;

  constructor(systemPrompt: string, model: string) {
    this.systemPrompt = systemPrompt;
    this.model = model;
    this.messages = [{ role: "system", content: systemPrompt }];
  }

  addUser(text: string): void {
    this.messages.push({ role: "user", content: text });
  }

  clear(): void {
    this.messages = [{ role: "system", content: this.systemPrompt }];
  }

  setModel(model: string): void {
    this.model = model;
  }

  toggleMode(): Mode {
    this.mode = this.mode === "normal" ? "plan" : "normal";
    return this.mode;
  }
}
```

- [ ] **Step 4:** `npx vitest run src/session/session.test.ts` — 5 PASS。
- [ ] **Step 5:** `npx tsc --noEmit` — clean。
- [ ] **Step 6:** 提交
```bash
git add src/session/session.ts src/session/session.test.ts
git commit -m "feat(session): Session holding messages/model/mode"
```

---

## Task 4: 重构 agent loop → runTurn(session)

**Files:** Modify `src/agent/loop.ts`, Rewrite `src/agent/loop.test.ts`

**契约:** 把单轮 `runAgent(prompt)` 改为 `runTurn(deps)`:在**已存在的 `session.messages`** 上跑一个用户回合——循环 `streamChat`(model 取 `session.model`,tools 取 `apiToolsForMode(registry, session.mode)`)、渲染、追加 assistant、若有 tool_calls 则并发执行并追加结果、继续;无 tool_calls 即结束;`maxTurns` 兜底。渲染逻辑 `renderTurn` 保持不变。

- [ ] **Step 1: 整体重写 `src/agent/loop.test.ts`(EXACT)**
```ts
import { describe, it, expect } from "vitest";
import { runTurn } from "./loop.js";
import { Session } from "../session/session.js";
import { ToolRegistry } from "../tools/registry.js";
import { defineTool } from "../tools/types.js";
import { z } from "zod";
import type { AssistantMessage, StreamChatOptions, StreamDelta, ToolMessage } from "../client/types.js";
import type { ApprovalGate } from "../approval/types.js";

const config = { baseUrl: "https://x", apiKey: "sk" };
const ctx = { workspaceRoot: "/tmp" };
const stubGate: ApprovalGate = { needsApproval: () => false, requestBatch: async () => new Map() };

function turn(deltas: StreamDelta[], message: AssistantMessage) {
  return async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
    for (const d of deltas) yield d;
    return message;
  };
}
function scripted(turns: Array<() => AsyncGenerator<StreamDelta, AssistantMessage>>) {
  let i = 0;
  return () => turns[i++]!();
}
function emptyReg() {
  return new ToolRegistry();
}

describe("runTurn", () => {
  it("appends the assistant reply to the session when no tools requested", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    await runTurn({
      session: s,
      config,
      registry: emptyReg(),
      ctx,
      gate: stubGate,
      streamChat: scripted([turn([{ kind: "content", text: "hello" }], { role: "assistant", content: "hello" })]),
      executeToolCalls: async () => [],
      write: () => {},
    });
    expect(s.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("sends session.model and runs tools then loops", async () => {
    const s = new Session("SYS", "deepseek-v4-flash");
    s.addUser("go");
    let sentModel = "";
    const assistantWithTool: AssistantMessage = {
      role: "assistant", content: null,
      tool_calls: [{ id: "c0", type: "function", function: { name: "read_file", arguments: "{}" } }],
    };
    const toolMsgs: ToolMessage[] = [{ role: "tool", tool_call_id: "c0", content: "R" }];
    await runTurn({
      session: s,
      config,
      registry: emptyReg(),
      ctx,
      gate: stubGate,
      streamChat: ((opts: StreamChatOptions) => {
        sentModel = opts.model;
        return scripted([
          turn([], assistantWithTool),
          turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" }),
        ])();
      }) as any,
      executeToolCalls: async () => toolMsgs,
      write: () => {},
    });
    expect(sentModel).toBe("deepseek-v4-flash");
    expect(s.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
  });

  it("omits write/exec tools in plan mode", async () => {
    const r = new ToolRegistry();
    r.register(defineTool({ name: "read_file", description: "", capability: "read", approval: "auto", schema: z.object({}), handler: async () => "" }));
    r.register(defineTool({ name: "write_file", description: "", capability: "write", approval: "required", schema: z.object({}), handler: async () => "" }));
    const s = new Session("SYS", "m");
    s.addUser("plan something");
    s.toggleMode(); // → plan
    let sentTools: string[] | undefined;
    await runTurn({
      session: s,
      config,
      registry: r,
      ctx,
      gate: stubGate,
      streamChat: ((opts: StreamChatOptions) => {
        sentTools = opts.tools?.map((t) => t.function.name);
        return turn([{ kind: "content", text: "ok" }], { role: "assistant", content: "ok" })();
      }) as any,
      executeToolCalls: async () => [],
      write: () => {},
    });
    expect(sentTools).toEqual(["read_file"]); // write_file dropped in plan
  });

  it("stops at maxTurns", async () => {
    const s = new Session("SYS", "m");
    s.addUser("loop");
    const looping = () => turn([], { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "x", arguments: "{}" } }] })();
    const written: string[] = [];
    await runTurn({
      session: s,
      config,
      registry: emptyReg(),
      ctx,
      gate: stubGate,
      streamChat: scripted([looping, looping, looping, looping]),
      executeToolCalls: async () => [{ role: "tool", tool_call_id: "c", content: "x" }],
      write: (t) => written.push(t),
      maxTurns: 2,
    });
    expect(written.join("")).toContain("最大轮数");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/agent/loop.test.ts` — FAIL(`runTurn` 不存在)。

- [ ] **Step 3: 改 `src/agent/loop.ts`** —— 保留 `renderTurn`,把 `AgentDeps`/`runAgent` 换成 `TurnDeps`/`runTurn`:
```ts
import type {
  AssistantMessage,
  StreamChatOptions,
  StreamDelta,
  ToolCall,
  ToolMessage,
} from "../client/types.js";
import type { ToolContext } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ApprovalGate } from "../approval/types.js";
import type { Session } from "../session/session.js";
import { apiToolsForMode } from "../tools/tools_for_mode.js";

export interface TurnDeps {
  session: Session;
  config: { baseUrl: string; apiKey: string };
  registry: ToolRegistry;
  ctx: ToolContext;
  gate: ApprovalGate;
  streamChat: (opts: StreamChatOptions) => AsyncGenerator<StreamDelta, AssistantMessage>;
  executeToolCalls: (
    toolCalls: ToolCall[],
    registry: ToolRegistry,
    ctx: ToolContext,
    gate: ApprovalGate,
  ) => Promise<ToolMessage[]>;
  write: (s: string) => void;
  maxTurns?: number;
}

// 驱动一轮 streamChat:渲染 delta,返回拼好的 assistant 消息。(与 M2 一致)
async function renderTurn(
  gen: AsyncGenerator<StreamDelta, AssistantMessage>,
  write: (s: string) => void,
): Promise<AssistantMessage> {
  let inReasoning = false;
  let r = await gen.next();
  while (!r.done) {
    const d = r.value;
    if (d.kind === "reasoning") {
      if (!inReasoning) { write("\x1b[90m"); inReasoning = true; }
      write(d.text);
    } else if (d.kind === "content") {
      if (inReasoning) { write("\x1b[0m\n\n"); inReasoning = false; }
      write(d.text);
    } else {
      if (inReasoning) { write("\x1b[0m\n"); inReasoning = false; }
      write(`\n→ ${d.name}\n`);
    }
    r = await gen.next();
  }
  if (inReasoning) write("\x1b[0m");
  write("\n");
  return r.value;
}

// 在已有的 session.messages 上跑一个用户回合,直到模型不再请求工具。
export async function runTurn(deps: TurnDeps): Promise<void> {
  const { session } = deps;
  const maxTurns = deps.maxTurns ?? 25;
  for (let t = 0; t < maxTurns; t++) {
    const tools = apiToolsForMode(deps.registry, session.mode);
    const gen = deps.streamChat({
      baseUrl: deps.config.baseUrl,
      apiKey: deps.config.apiKey,
      model: session.model,
      messages: session.messages,
      ...(tools.length > 0 ? { tools, parallelToolCalls: true } : {}),
    });
    const assistant = await renderTurn(gen, deps.write);
    session.messages.push(assistant);
    if (!assistant.tool_calls || assistant.tool_calls.length === 0) return;
    const toolMessages = await deps.executeToolCalls(assistant.tool_calls, deps.registry, deps.ctx, deps.gate);
    session.messages.push(...toolMessages);
  }
  deps.write("\n[已达最大轮数,停止]\n");
}
```

- [ ] **Step 4:** `npx vitest run src/agent/loop.test.ts` — 4 PASS。
- [ ] **Step 5:** `npx tsc --noEmit`。Expected:报错只在 `src/index.ts`(仍调旧 `runAgent`)——预期,Task 7 修。确认错误只在 index.ts。
- [ ] **Step 6:** 提交
```bash
git add src/agent/loop.ts src/agent/loop.test.ts
git commit -m "feat(agent): runTurn over a persistent Session with mode-aware tools"
```

---

## Task 5: 斜杠命令

**Files:** Create `src/commands/commands.ts`, Test `src/commands/commands.test.ts`

**契约:** `dispatchCommand(input, session): { handled; output?; exit? }`。非 `/` 开头 → `{handled:false}`。识别:`/model [id]`(给 id 则设,否则在 pro/flash 间切)、`/plan`(切模式)、`/clear`(清空)、`/help`、`/exit`|`/quit`(置 exit)、`/compact`(回"尚未实现")、未知命令(handled+提示)。

- [ ] **Step 1: 失败测试 `src/commands/commands.test.ts`(EXACT)**
```ts
import { describe, it, expect } from "vitest";
import { dispatchCommand } from "./commands.js";
import { Session } from "../session/session.js";

function sess() {
  return new Session("SYS", "deepseek-v4-pro");
}

describe("dispatchCommand", () => {
  it("treats non-slash input as not a command", () => {
    expect(dispatchCommand("hello", sess()).handled).toBe(false);
  });

  it("/model with no arg toggles pro<->flash", () => {
    const s = sess();
    const r = dispatchCommand("/model", s);
    expect(r.handled).toBe(true);
    expect(s.model).toBe("deepseek-v4-flash");
    dispatchCommand("/model", s);
    expect(s.model).toBe("deepseek-v4-pro");
  });

  it("/model <id> sets the model", () => {
    const s = sess();
    dispatchCommand("/model deepseek-v4-flash", s);
    expect(s.model).toBe("deepseek-v4-flash");
  });

  it("/plan toggles mode", () => {
    const s = sess();
    dispatchCommand("/plan", s);
    expect(s.mode).toBe("plan");
    dispatchCommand("/plan", s);
    expect(s.mode).toBe("normal");
  });

  it("/clear resets the conversation", () => {
    const s = sess();
    s.addUser("a");
    dispatchCommand("/clear", s);
    expect(s.messages).toHaveLength(1);
  });

  it("/exit signals exit", () => {
    expect(dispatchCommand("/exit", sess()).exit).toBe(true);
  });

  it("/compact reports not-yet-implemented", () => {
    const r = dispatchCommand("/compact", sess());
    expect(r.handled).toBe(true);
    expect(r.output).toMatch(/未实现|尚未/);
  });

  it("unknown command is handled with a hint", () => {
    const r = dispatchCommand("/wat", sess());
    expect(r.handled).toBe(true);
    expect(r.output).toContain("未知命令");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/commands/commands.test.ts` — FAIL。

- [ ] **Step 3: 写 `src/commands/commands.ts`(EXACT)**
```ts
import type { Session } from "../session/session.js";

export interface CommandResult {
  handled: boolean;
  output?: string;
  exit?: boolean;
}

export function dispatchCommand(input: string, session: Session): CommandResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { handled: false };
  const parts = trimmed.slice(1).split(/\s+/);
  const cmd = parts[0] ?? "";
  const arg = parts.slice(1).join(" ");

  switch (cmd) {
    case "model": {
      if (arg) {
        session.setModel(arg);
        return { handled: true, output: `已切换模型:${arg}` };
      }
      const next = session.model.includes("flash") ? "deepseek-v4-pro" : "deepseek-v4-flash";
      session.setModel(next);
      return { handled: true, output: `已切换模型:${next}` };
    }
    case "plan": {
      const m = session.toggleMode();
      return {
        handled: true,
        output: m === "plan" ? "已进入 plan 模式(只读+提方案)" : "已回到 normal 模式",
      };
    }
    case "clear":
      session.clear();
      return { handled: true, output: "已清空对话(保留系统设定)" };
    case "compact":
      return { handled: true, output: "compact 尚未实现(将在后续里程碑加入)" };
    case "help":
      return {
        handled: true,
        output: "/model [id] 切模型 · /plan 切模式 · /clear 清空 · /compact(待实现) · /exit 退出",
      };
    case "exit":
    case "quit":
      return { handled: true, exit: true, output: "再见。" };
    default:
      return { handled: true, output: `未知命令:/${cmd}(/help 看可用命令)` };
  }
}
```

- [ ] **Step 4:** `npx vitest run src/commands/commands.test.ts` — 8 PASS。
- [ ] **Step 5:** `npx tsc --noEmit`(index.ts 仍报错,预期)。
- [ ] **Step 6:** 提交
```bash
git add src/commands/commands.ts src/commands/commands.test.ts
git commit -m "feat(commands): slash command dispatch (/model /plan /clear /help /exit)"
```

---

## Task 6: 审批提示注入化 + REPL 循环

**Files:** Modify `src/approval/stdin_prompt.ts`; Delete `src/tools/stdin_ask.ts`; Create `src/repl.ts`, Test `src/repl.test.ts`

**说明:** 让审批提示走注入的 `ask(prompt): Promise<string>`(而非自建 readline),与 REPL 共用同一个 stdin。`stdinAsk` 删除(ctx.ask 在 index 用 ask 构建)。`runRepl` 可注入 `readLine`/`runTurn`,纯逻辑可测。

- [ ] **Step 1: 改 `src/approval/stdin_prompt.ts`** 为工厂式(注入 ask):
```ts
import type { ApprovalDecision, ApprovalPrompt, ApprovalRequest } from "./types.js";

// 用注入的 ask(prompt→一行回答)构建审批提示函数,与 REPL 共用同一 stdin。
export function makeApprovalPrompt(ask: (prompt: string) => Promise<string>): ApprovalPrompt {
  return async (requests: ApprovalRequest[]) => {
    const out = new Map<string, ApprovalDecision>();
    for (const req of requests) {
      const ans = (await ask(`\n需要批准:${req.summary}\n  [y]本次  [s]本会话  [a]永久  [n]拒绝 > `))
        .trim()
        .toLowerCase();
      const decision: ApprovalDecision =
        ans === "y" ? "once" : ans === "s" ? "session" : ans === "a" ? "always" : "deny";
      out.set(req.id, decision);
    }
    return out;
  };
}
```

- [ ] **Step 2: 删除 `src/tools/stdin_ask.ts`**(被 index 内联的 ask 取代):
```bash
cd /Users/huaruoxu/ClaudeProject/career_plan/code/codeds
git rm src/tools/stdin_ask.ts
```

- [ ] **Step 3: 失败测试 `src/repl.test.ts`(EXACT)**
```ts
import { describe, it, expect } from "vitest";
import { runRepl } from "./repl.js";
import { Session } from "./session/session.js";

function lineFeeder(lines: string[]) {
  let i = 0;
  return async () => (i < lines.length ? lines[i++]! : null);
}

describe("runRepl", () => {
  it("runs a turn for plain input and handles a command, then exits on /exit", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    const turns: string[] = [];
    const written: string[] = [];
    await runRepl({
      session: s,
      readLine: lineFeeder(["hello", "/plan", "/exit"]),
      runTurn: async () => { turns.push(s.messages[s.messages.length - 1]!.content as string); },
      write: (t) => written.push(t),
    });
    // "hello" 触发一次 turn;/plan 切模式;/exit 退出
    expect(turns).toEqual(["hello"]);
    expect(s.mode).toBe("plan");
    expect(written.join("")).toContain("plan 模式");
  });

  it("stops at EOF (readLine returns null)", async () => {
    const s = new Session("SYS", "m");
    let turnCount = 0;
    await runRepl({
      session: s,
      readLine: lineFeeder(["hi"]), // 之后返回 null
      runTurn: async () => { turnCount++; },
      write: () => {},
    });
    expect(turnCount).toBe(1);
  });

  it("ignores blank lines", async () => {
    const s = new Session("SYS", "m");
    let turnCount = 0;
    await runRepl({
      session: s,
      readLine: lineFeeder(["   ", "hi"]),
      runTurn: async () => { turnCount++; },
      write: () => {},
    });
    expect(turnCount).toBe(1);
  });
});
```

- [ ] **Step 4:** `npx vitest run src/repl.test.ts` — FAIL。

- [ ] **Step 5: 写 `src/repl.ts`(EXACT)**
```ts
import { dispatchCommand } from "./commands/commands.js";
import type { Session } from "./session/session.js";

export interface ReplDeps {
  session: Session;
  // 读一行用户输入;EOF 返回 null。
  readLine: () => Promise<string | null>;
  // 在 session 上跑一个回合(由 index 绑定真实依赖)。
  runTurn: () => Promise<void>;
  write: (s: string) => void;
}

export async function runRepl(deps: ReplDeps): Promise<void> {
  for (;;) {
    const line = await deps.readLine();
    if (line === null) return; // EOF
    const cmd = dispatchCommand(line, deps.session);
    if (cmd.handled) {
      if (cmd.output) deps.write(cmd.output + "\n");
      if (cmd.exit) return;
      continue;
    }
    if (!line.trim()) continue;
    deps.session.addUser(line);
    await deps.runTurn();
  }
}
```

- [ ] **Step 6:** `npx vitest run src/repl.test.ts` — 3 PASS。
- [ ] **Step 7:** `npx tsc --noEmit`(index.ts 仍报错,预期)。
- [ ] **Step 8:** 提交
```bash
git add src/approval/stdin_prompt.ts src/repl.ts src/repl.test.ts
git commit -m "feat(repl): injectable REPL loop; approval prompt via shared ask"
```

---

## Task 7: 装配 index(单一 stdin、argv 一次性 vs REPL)+ 全量验收

**Files:** Rewrite `src/index.ts`

- [ ] **Step 1: 整体重写 `src/index.ts`(EXACT)**
```ts
import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config/config.js";
import { streamChat } from "./client/client.js";
import { runTurn } from "./agent/loop.js";
import { executeToolCalls } from "./tools/execute.js";
import { ToolRegistry } from "./tools/registry.js";
import { readFileTool } from "./tools/read_file.js";
import { listDirTool } from "./tools/list_dir.js";
import { writeFileTool } from "./tools/write_file.js";
import { editFileTool } from "./tools/edit_file.js";
import { execShellTool } from "./tools/exec_shell.js";
import { execShellPollTool } from "./tools/exec_shell_poll.js";
import { execShellKillTool } from "./tools/exec_shell_kill.js";
import { grepFilesTool } from "./tools/grep_files.js";
import { fileSearchTool } from "./tools/file_search.js";
import { askUserTool } from "./tools/ask_user.js";
import { fetchUrlTool } from "./tools/fetch_url.js";
import { webSearchTool } from "./tools/web_search.js";
import { todoWriteTool } from "./tools/todo_write.js";
import { SessionApprovalGate } from "./approval/gate.js";
import { makeApprovalPrompt } from "./approval/stdin_prompt.js";
import { loadAlwaysApproved, appendAlwaysApproved } from "./approval/store.js";
import { buildSystemPrompt } from "./prompt/system_prompt.js";
import { Session } from "./session/session.js";
import { runRepl } from "./repl.js";
import path from "node:path";

async function main() {
  const argvPrompt = process.argv.slice(2).join(" ").trim();

  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const workspaceRoot = process.cwd();
  const approvalsFile = path.join(workspaceRoot, ".codeds", "approvals.json");

  const registry = new ToolRegistry();
  for (const t of [
    readFileTool, listDirTool, writeFileTool, editFileTool,
    execShellTool, execShellPollTool, execShellKillTool,
    grepFilesTool, fileSearchTool, askUserTool, fetchUrlTool, webSearchTool, todoWriteTool,
  ]) {
    registry.register(t);
  }

  const toolSummaries = registry
    .toApiTools()
    .map((t) => `- ${t.function.name}:${t.function.description}`)
    .join("\n");
  const systemPrompt = buildSystemPrompt({ modelId: cfg.model, toolSummaries });

  // 单一 readline → 一个 ask(prompt→一行),供 REPL / 审批 / ask_user 共用。
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt: string) => rl.question(prompt);

  const alwaysApproved = await loadAlwaysApproved(approvalsFile);
  const gate = new SessionApprovalGate(makeApprovalPrompt(ask), alwaysApproved, (name) =>
    appendAlwaysApproved(approvalsFile, name),
  );

  const session = new Session(systemPrompt, cfg.model);
  const ctx = {
    workspaceRoot,
    readFiles: new Set<string>(),
    ask: (q: string) => ask(`\n${q}\n> `),
    fetchImpl: fetch,
  };
  const write = (s: string) => process.stdout.write(s);

  const runOneTurn = () =>
    runTurn({
      session,
      config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
      registry,
      ctx,
      gate,
      streamChat,
      executeToolCalls,
      write,
    });

  try {
    if (argvPrompt) {
      session.addUser(argvPrompt);
      await runOneTurn();
      return;
    }
    write(`codeds —— 输入消息开始;/help 看命令,/exit 退出。\n`);
    let closed = false;
    rl.on("close", () => { closed = true; });
    const readLine = async (): Promise<string | null> => {
      if (closed) return null;
      try {
        return await rl.question("\n> ");
      } catch {
        return null;
      }
    };
    await runRepl({ session, readLine, runTurn: runOneTurn, write });
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("\n" + (err as Error).message);
  process.exit(1);
});
```

- [ ] **Step 2: 全量 typecheck** —— `npx tsc --noEmit`。Expected:退出码 0,零错误。
- [ ] **Step 3: 全量测试** —— `npx vitest run`。Expected:全 PASS。预期新增:system_prompt(5)、tools_for_mode(2)、session(5)、loop(4,改写)、commands(8)、repl(3);删除 runner 早已无;在 M4 的 116 基础上净增约 +25 ≈ **~135 用例**(loop 从 5→4 少 1;具体以实际为准)。报实际总数。
- [ ] **Step 4: 无网络冒烟** ——
  `DEEPSEEK_API_KEY= npm run dev -- "hi"` → 含 "Missing DEEPSEEK_API_KEY",退出 1。
  REPL 命令(无网络,管道喂):`printf '/help\n/plan\n/exit\n' | DEEPSEEK_API_KEY=x npm run dev` → 应打印 help 文本、"已进入 plan 模式"、"再见。" 并正常退出 0(命令在调用模型前处理,不触网)。报实际输出。
- [ ] **Step 5:** 提交
```bash
cd /Users/huaruoxu/ClaudeProject/career_plan/code/codeds
git add src/index.ts
git commit -m "feat: interactive REPL with system prompt, modes, commands; argv one-shot retained"
```

---

## Task 8: 真网络/端到端验收

> key 桥接,不回显。**由 controller 执行。**

- [ ] **Step 1: 一次性(现在带系统 prompt + 工具速查)** ——
```bash
set -a && . ./.env && set +a && DEEPSEEK_API_KEY="$DS_API_KEY" npm run dev -- "你现在是什么模式?有哪些工具?用一句话回答,别调用工具" 2>&1
```
Expected:模型据系统 prompt 回答(normal 模式、列举若干工具),退出 0。

- [ ] **Step 2: REPL 多轮 + 命令 + plan 模式拦截写** ——
```bash
set -a && . ./.env && set +a && printf '/plan\n在当前目录创建 m5.txt 内容 hi\n/exit\n' | DEEPSEEK_API_KEY="$DS_API_KEY" npm run dev 2>&1; echo "===m5.txt 应不存在==="; ls m5.txt 2>&1
```
Expected:`/plan` 进入 plan 模式;随后要求建文件时,**因 plan 下 write_file 不在工具表**,模型只能说明无法在 plan 模式修改/给出方案,**不会真的创建** `m5.txt`(ls 报不存在);`/exit` 退出 0。这验证了"代码强制 plan 只读"。

- [ ] **Step 3: REPL 切回 normal 后可写(审批)** ——
```bash
set -a && . ./.env && set +a && printf '在当前目录创建 m5.txt 内容 hi\ny\n/exit\n' | DEEPSEEK_API_KEY="$DS_API_KEY" npm run dev 2>&1; echo "===m5.txt==="; cat m5.txt 2>&1; rm -f m5.txt
```
Expected:normal 模式下模型调 write_file → 审批提示 → 管道 `y` 放行 → 创建 `m5.txt`(cat 显示 `hi`);`/exit` 退出 0。(随后已 rm 清理。)

- [ ] **Step 4: 记录结论** —— 把 M5 验收结果(系统 prompt 生效、REPL 多轮、命令、plan 代码强制只读)一句话追加到设计文档 §8 末尾。提交:
```bash
git add docs/2026-06-04-deepseek-coding-agent-design.md
git commit -m "docs: record M5 prompt/modes/REPL acceptance"
```

---

## 验收标准(M5 完成的定义)

- [ ] `npx vitest run` 全绿(约 135 用例,见 Task 7 Step 3)。
- [ ] `npx tsc --noEmit` 零错。
- [ ] 缺 key 冒烟退出 1;REPL 命令冒烟(无网络)打印 help/plan/再见并退出 0。
- [ ] 系统 prompt:占位符全填、含模式/任务规划/工具段(有测试)。
- [ ] 模式:plan 下 `apiToolsForMode` 移除写/执行工具(有测试);runTurn 在 plan 下只发只读工具(有测试)。
- [ ] Session:addUser 追加、clear 重置、setModel 不动 messages、toggleMode 翻转(有测试)。
- [ ] 命令:/model(切/设)、/plan、/clear、/help、/exit、/compact(stub)、未知(有测试)。
- [ ] REPL:命令处理、跑回合、blank 跳过、EOF/`/exit` 退出(有测试)。
- [ ] 单一 stdin:REPL/审批/ask_user 共用一个 ask,不抢输入。
- [ ] 真网络:一次性带系统 prompt;REPL 多轮 + 命令;**plan 模式靠代码拦住写**(Task 8)。

## 给后续里程碑留的 carry-over

- **/compact 与压缩**(M7):命令已留 stub;接 session 压缩(系统前缀+记忆+旧对话摘要+最近 N 轮)。
- **子代理**(M8):prompt 加"子代理策略"段;`agent` 工具。
- **富 TUI**(M9):markdown 渲染、CJK 宽度、审批/REPL 的更好交互;现为纯文本 + ANSI。
- **项目指令文件**:`{project_instruction_files}` 现填"(无)";加载项目级指令文件留后续。
- **prompt 里 model_id 的 cosmetic 过时**:/model 切换后系统 prompt 仍显示起始模型(刻意为 cache 稳定);如需准确可在切换时注入一条轻量提醒消息(尾部,不改 messages[0])。
- **approval 三档** / **web_search 健壮性** / **edit_file 越界测试** / **执行器并发回归测试** —— 仍在。
