# 子代理对齐 CC · Part B(双向事件驱动通信)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 补齐"运行中后台子代理 → 父代理"的 mid-run 通信(进度/发现/提问),并让它经事件驱动自动续跑流回父模型——TTY 与非 TTY 两条路径都覆盖,零副作用。

**Architecture:** 读码后确认大半已存在——父→子(`task_send`/`drainPending`)与 TTY 事件驱动自动续跑(App.tsx `processNotifications`)都已就绪,且子代理 mid-run 消息复用既有 `notifications` 队列即可**自动**流经 TTY 自动续跑(TTY 无需改代码)。真正缺的是:① taskManager 的"运行中任务→父"出口 `emitFromTask`;② 子代理侧 `message_parent` 工具 + ctx 绑定;③ 非 TTY `runRepl` 的回合边界 drain + 自动续跑(增量、零副作用)。

**Tech Stack:** TypeScript ESM(`.js` 后缀)、Zod、Vitest。`npx vitest run <file>`;`npm run typecheck`;`npm run lint`(0 error);`npm test`。

参见 spec:`docs/design/specs/2026-06-17-subagent-cc-parity-design.md`(Part B 节)。本计划接续 Part A(已合并 master)。

---

## 现状(读码确认,避免重复造)
- 父→运行中子:`task_send` 工具 → `ctx.sendToTask` → `taskManager.send(id,msg)` → 子代理 `loop.ts:148` 回合边界 `drainPending` 消费。**已存在,不动。**
- TTY 事件驱动:`taskManager.onChange` → App.tsx:457 `subscribeTasks`→`taskTick`→useEffect(460)→`processNotifications`(429),**空闲时**把 `drainNotifications()` 的内容当新回合自动喂模型。**已存在。**
- 缺口:子代理**中途**无法主动发消息给父(只有最终完成通知);非 TTY `runRepl` 根本不 drain 通知(后台结果静默丢)。

## File Structure
| 文件 | 职责 | 改动 |
|---|---|---|
| `src/agent/tasks.ts` | 加 `emitFromTask(id,msg)`:运行中任务→父的 mid-run 消息进 `notifications` + `notify()` | 加方法 + 接口 |
| `src/tools/types.ts` | `ToolContext` 加 `messageParent?` | 加字段 |
| `src/tools/message_parent.ts` | 新工具:后台子代理给父发 mid-run 消息 | 新建 |
| `src/index.ts` | 注册新工具;runSubagent opts 透传 messageParent 进子 ctx;runBackgroundAgent 绑定;非 TTY runRepl 传 drainNotifications | 改 |
| `src/repl.ts` | 回合边界 drain 通知 + 自动续跑(增量) | 改 |
| 测试 | 各任务对应 | 加 |

---

## Task 1: taskManager.emitFromTask —— 运行中任务→父 的 mid-run 出口

**Files:** Modify `src/agent/tasks.ts`;Test `src/agent/tasks.test.ts`(无则新建)。

- [ ] **Step 1: 写失败测试** — 新建/追加 `src/agent/tasks.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createTaskManager } from "./tasks.js";

describe("emitFromTask (mid-run 子→父)", () => {
  it("运行中任务发消息 → 进 notifications + 触发 onChange", async () => {
    const tm = createTaskManager();
    let changes = 0;
    tm.onChange(() => { changes++; });
    let release!: (v: string) => void;
    const id = tm.launch("t", () => new Promise<string>((res) => { release = res; }));
    const before = changes;
    const ok = tm.emitFromTask(id, "进度:第 1/3 步完成");
    expect(ok).toBe(true);
    expect(changes).toBe(before + 1); // 触发了 onChange
    const notes = tm.drainNotifications();
    expect(notes.join("\n")).toContain("进度:第 1/3 步完成");
    expect(notes.join("\n")).toContain(id);
    release("done"); // 收尾,避免悬挂
  });
  it("非运行任务(不存在)→ 返回 false,不入队", () => {
    const tm = createTaskManager();
    expect(tm.emitFromTask("task-999", "x")).toBe(false);
    expect(tm.drainNotifications()).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑确认失败** — `npx vitest run src/agent/tasks.test.ts`(`emitFromTask` 未定义)。

- [ ] **Step 3: 实现** — `src/agent/tasks.ts`:
  - `TaskManager` 接口(14-30 行)在 `send` 附近加:
```ts
  // 运行中任务给父代理发一条 mid-run 消息(进度/发现/提问):入通知队列 + 触发 onChange。
  emitFromTask(id: string, message: string): boolean;
```
  - 在 `notificationXml` 函数后加 mid-run 消息的 XML:
```ts
function taskMessageXml(t: BgTask, message: string): string {
  return [
    `<task-message>`,
    `<task-id>${t.id}</task-id>`,
    `<description>${t.description}</description>`,
    `<message>`,
    message,
    `</message>`,
    `</task-message>`,
  ].join("\n");
}
```
  - 在返回对象里(`send` 之后)加:
```ts
    emitFromTask(id, message) {
      const t = tasks.get(id);
      if (!t || t.status !== "running") return false;
      notifications.push(taskMessageXml(t, message));
      notify();
      return true;
    },
```

- [ ] **Step 4: 跑确认通过** — `npx vitest run src/agent/tasks.test.ts` · `npm run typecheck`。

- [ ] **Step 5: 提交**
```bash
git add src/agent/tasks.ts src/agent/tasks.test.ts
git commit -m "feat(agent): taskManager.emitFromTask——运行中子代理→父的 mid-run 消息通道"
```

---

## Task 2: message_parent 工具 + ToolContext.messageParent

**Files:** Create `src/tools/message_parent.ts`;Modify `src/tools/types.ts`;Test `src/tools/message_parent.test.ts`。

- [ ] **Step 1: 写失败测试** — 新建 `src/tools/message_parent.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { messageParentTool } from "./message_parent.js";

describe("message_parent 工具", () => {
  it("有 messageParent → 调用并回执", async () => {
    const sent: string[] = [];
    const ctx = { workspaceRoot: "/tmp", readFiles: new Set<string>(), messageParent: (m: string) => sent.push(m) } as any;
    const r = await messageParentTool.handler({ message: "进度:1/3" } as any, ctx);
    expect(sent).toEqual(["进度:1/3"]);
    expect(r).toContain("已发送");
  });
  it("无 messageParent(非后台子代理)→ 友好提示,不报错", async () => {
    const ctx = { workspaceRoot: "/tmp", readFiles: new Set<string>() } as any;
    const r = await messageParentTool.handler({ message: "x" } as any, ctx);
    expect(r).toContain("非后台子代理");
  });
});
```

- [ ] **Step 2: 跑确认失败** — `npx vitest run src/tools/message_parent.test.ts`。

- [ ] **Step 3: 实现工具** — 新建 `src/tools/message_parent.ts`:

```ts
import { z } from "zod";
import { defineTool } from "./types.js";

// 后台子代理给派发它的父代理发一条 mid-run 消息(进度/中间发现/澄清问题)。
// 父代理空闲时经通知队列自动收到。仅后台子代理可用(前台子代理结论在完成时直接返回)。
export const messageParentTool = defineTool({
  name: "message_parent",
  description:
    "(后台子代理用)给派发你的父代理发一条中途消息——进度、中间发现、或需要澄清的问题。父代理空闲时会收到。" +
    "仅当你是后台子代理时有效;前台子代理无需用它(结论会在完成时直接返回父代理)。",
  capability: "plan",
  approval: "auto",
  schema: z.object({
    message: z.string().min(1).describe("发给父代理的中途消息(进度/发现/问题)"),
  }),
  handler: async (args, ctx) => {
    if (!ctx.messageParent) {
      return "你不是后台子代理(无父任务通道):你的结论会在完成时直接返回父代理,无需中途发送。";
    }
    ctx.messageParent(args.message);
    return "已发送给父代理(它空闲时会看到)。";
  },
});
```

- [ ] **Step 4: 加 ToolContext 字段** — `src/tools/types.ts`,在 `sendToTask?` 附近加:
```ts
  // (后台子代理用)给父代理发 mid-run 消息;由 runBackgroundAgent 绑定到本任务 id。前台子代理为 undefined。
  messageParent?: (message: string) => void;
```

- [ ] **Step 5: 跑确认通过** — `npx vitest run src/tools/message_parent.test.ts` · `npm run typecheck`。

- [ ] **Step 6: 提交**
```bash
git add src/tools/message_parent.ts src/tools/types.ts src/tools/message_parent.test.ts
git commit -m "feat(agent): message_parent 工具 + ToolContext.messageParent(子→父 mid-run)"
```

---

## Task 3: 接线 —— 注册工具 + runSubagent 透传 + runBackgroundAgent 绑定

**Files:** Modify `src/index.ts`。

- [ ] **Step 1: 注册工具** — `src/index.ts`:顶部 import 加 `import { messageParentTool } from "./tools/message_parent.js";`(仿 `task_send` 的 import,约 56 行)。找到注册工具的数组(约 293 行 `registry.register(t)` 前的工具列表),把 `messageParentTool` 加入,与 `taskSendTool` 并列。

- [ ] **Step 2: runSubagent opts 加 messageParent + 注入子 ctx** — `src/index.ts:585` runSubagent 的解构参数加 `messageParent`:
```ts
  ctx.runSubagent = ({ task, signal, agentType, workspaceRoot: wsRoot, drainPending, auditAgent = "sub", model, mode, messageParent }) => {
```
  并把它注入子代理 ctx——找到 `const subCtx = wsRoot ? { ...ctx, workspaceRoot: wsRoot } : ctx;`(约 589 行)改为:
```ts
    const subCtx = {
      ...(wsRoot ? { ...ctx, workspaceRoot: wsRoot } : ctx),
      ...(messageParent ? { messageParent } : {}),
    };
```

- [ ] **Step 3: runSubagent 的 opts 类型加 messageParent** — `src/tools/types.ts` 的 `runSubagent?` opts 对象加一行(在 mode 之后):
```ts
    messageParent?: (message: string) => void; // 后台子代理→父的 mid-run 出口(runBackgroundAgent 绑定)
```

- [ ] **Step 4: runBackgroundAgent 绑定 messageParent** — `src/index.ts:640-642` 改为:
```ts
  ctx.runBackgroundAgent = (task: string, agentType?: string) =>
    taskManager.launch(`${agentType ? `[${agentType}] ` : ""}${task.slice(0, 50)}`, (signal, id) =>
      ctx.runSubagent!({
        task, signal, agentType,
        drainPending: () => taskManager.drainPending(id),
        auditAgent: "bg",
        messageParent: (m) => { taskManager.emitFromTask(id, m); },
      }),
    );
```

- [ ] **Step 5: typecheck + 不回归** — `npm run typecheck` · `npx vitest run src/agent/subagent.test.ts src/tools/agent.test.ts`。

- [ ] **Step 6: 提交**
```bash
git add src/index.ts src/tools/types.ts
git commit -m "feat(agent): 接线 message_parent——注册工具 + runSubagent 透传 + 后台任务绑定 emitFromTask"
```

---

## Task 4: 非 TTY runRepl —— 回合边界 drain + 自动续跑(零副作用)

**Files:** Modify `src/repl.ts`、`src/index.ts`;Test `src/repl.test.ts`(既有,追加)。

- [ ] **Step 1: 写失败测试** — 追加到 `src/repl.test.ts`(仿其既有 lineFeeder/deps 构造):

```ts
import { describe, it, expect } from "vitest";
import { runRepl } from "./repl.js";

describe("runRepl 后台通知回合边界自动续跑", () => {
  it("一回合后有通知 → 自动再跑一回合喂通知;之后无通知则停", async () => {
    const turns: string[] = [];
    const session: any = { addUser: (t: string) => turns.push(t), messages: [] };
    let lines = ["第一条输入", null]; // 一条真实输入后 EOF
    let notesBatches = [["<task-message>进度</task-message>"], []]; // 第一次 drain 有一条,第二次空
    await runRepl({
      session,
      readLine: async () => lines.shift() ?? null,
      runTurn: async () => { /* no-op turn */ },
      compact: async () => {},
      write: () => {},
      drainNotifications: () => notesBatches.shift() ?? [],
    } as any);
    // 期望:用户输入入一回合 + 通知自动续一回合
    expect(turns.some((t) => t.includes("第一条输入"))).toBe(true);
    expect(turns.some((t) => t.includes("进度"))).toBe(true);
  });
  it("无 drainNotifications(或始终空)→ 行为不变(不额外跑回合)", async () => {
    const turns: string[] = [];
    const session: any = { addUser: (t: string) => turns.push(t), messages: [] };
    let lines = ["only", null];
    await runRepl({
      session,
      readLine: async () => lines.shift() ?? null,
      runTurn: async () => {},
      compact: async () => {},
      write: () => {},
    } as any); // 不传 drainNotifications
    expect(turns).toEqual(["only"]); // 仅一条,无自动续
  });
});
```

- [ ] **Step 2: 跑确认失败** — `npx vitest run src/repl.test.ts`(自动续跑未实现)。

- [ ] **Step 3: 实现** — `src/repl.ts`:
  - `ReplDeps` 接口加(在 `gateUserPrompt?` 后):
```ts
  // 取出待注入的后台任务通知/子代理 mid-run 消息(由 index 绑定 taskManager.drainNotifications)。
  // 省略 = 不处理后台通知(行为同旧版)。
  drainNotifications?: () => string[];
```
  - 在循环里 `await deps.runTurn();`(41 行)后加自动续跑:
```ts
    await deps.runTurn();
    // 回合边界:把后台任务完成/子代理 mid-run 消息作为新回合自动续跑,直到排空(零副作用:无通知则不动)。
    await drainAndContinue(deps);
```
  - 在 `runRepl` 函数外(或内)加 helper:
```ts
async function drainAndContinue(deps: ReplDeps): Promise<void> {
  if (!deps.drainNotifications) return;
  for (;;) {
    const notes = deps.drainNotifications();
    if (notes.length === 0) return;
    deps.write(`↩ 收到 ${notes.length} 个后台任务结果,继续处理…\n`);
    deps.session.addUser(notes.join("\n\n"));
    await deps.runTurn();
  }
}
```

- [ ] **Step 4: index 非 TTY 分支传 drainNotifications** — `src/index.ts` 非 TTY 分支的 `runRepl({ session, readLine, runTurn: runOneTurn, write, compact: runCompaction, ... })` 调用(约 1372 行,Part A 已加 gateUserPrompt),补一项:
```ts
        drainNotifications: () => taskManager.drainNotifications(),
```

- [ ] **Step 5: 跑确认通过 + 不回归** — `npx vitest run src/repl.test.ts` · `npm run typecheck`。

- [ ] **Step 6: 提交**
```bash
git add src/repl.ts src/index.ts
git commit -m "feat(agent): 非 TTY runRepl 回合边界 drain 后台通知+自动续跑(增量,零副作用)"
```

---

## Task 5: 集成 + 零副作用回归

**Files:** Test `src/agent/tasks.test.ts`(追加集成)。

- [ ] **Step 1: 写集成测试** — 验证后台子代理 `message_parent` → 父 `drainNotifications` 收到(全链)。追加到 `src/agent/tasks.test.ts`:

```ts
describe("集成:后台子代理 mid-run 消息流回父", () => {
  it("launch 的 run 内通过 emitFromTask(绑定 id)发消息 → 父 drainNotifications 能取到", async () => {
    const tm = createTaskManager();
    let release!: (v: string) => void;
    const id = tm.launch("调查任务", (_signal, taskId) => {
      // 模拟子代理中途用 message_parent → runBackgroundAgent 绑定的 messageParent = emitFromTask(taskId, .)
      tm.emitFromTask(taskId, "中间发现:配置在 config.ts");
      return new Promise<string>((res) => { release = res; });
    });
    // 让 microtask 跑完
    await Promise.resolve();
    const notes = tm.drainNotifications();
    expect(notes.join("\n")).toContain("中间发现:配置在 config.ts");
    expect(notes.join("\n")).toContain(id);
    release("最终结论");
  });
});
```

- [ ] **Step 2: 跑确认通过** — `npx vitest run src/agent/tasks.test.ts`。

- [ ] **Step 3: 全量回归(零副作用确认)** — `npm test`(既有用例全绿,尤其 repl.test.ts 旧用例、subagent/agent 用例不回归)· `npm run typecheck` · `npm run lint`(0 error)。

- [ ] **Step 4: 提交**
```bash
git add src/agent/tasks.test.ts
git commit -m "test(agent): 后台子代理 mid-run 消息流回父全链集成 + 零副作用回归"
```

---

## Self-Review(已执行)
**Spec 覆盖(Part B):** B-1 双向信道→T1(emitFromTask 复用 notifications);B-2 message_parent→T2;B-3 父→子→已存在(不动,现状节已记);B-4 事件驱动→TTY 已存在(emitFromTask 自动流经 processNotifications,无需改码,T5 集成验证)+ 非 TTY 新增(T4 回合边界 drain)。缓存安全:本部分只追加消息到队列尾、不碰任何会话前缀,无缓存影响。
**占位符扫描:** 无 TODO/占位;T1/T2/T4 测试均为真断言;T4 第二用例专门锁"零副作用"(不传 drainNotifications → 行为不变)。
**类型一致性:** `emitFromTask(id,message):boolean` 在 T1 定义于接口与实现;`ToolContext.messageParent?:(message:string)=>void` T2 定义、T3 注入、message_parent 工具消费;runSubagent opts 的 `messageParent?` T3 加入并与 runBackgroundAgent 绑定一致;`ReplDeps.drainNotifications?` T4 定义、index 传入。
**已知前置/边界:** 非 TTY 自动续跑在回合边界生效,不会在 readline 阻塞等输入时唤醒(已在设计中声明,非回归);message_parent 仅后台子代理有效,前台/无父通道时友好提示。TTY 路径无代码改动(复用既有 processNotifications),靠 T5 集成与既有 App 行为保证。
