# 前台任务快捷键转后台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交互模式下按 Ctrl+B,把当前正在前台跑的 Bash 命令和/或 Agent 子代理调用手动转成后台继续执行,主循环立刻恢复响应。

**Architecture:** 新增一个跨工具调用共享的"前台调用注册表"(`ForegroundRegistry`),挂在 `ToolContext` 上;`exec_shell.ts`/`agent.ts` 的前台路径各自向它注册一个"转后台"回调,`App.tsx` 的 Ctrl+B 处理器遍历注册表触发这些回调。Bash 的回调把已经在跑的 child 过继给 `processManager`;Agent 的回调 abort 当前子代理、等它清理完、用已产出的消息重新发起一个异步子代理调用(对标 Claude Code 的真实实现,不做"热摘出生成器"这种无先例的机制)。

**Tech Stack:** TypeScript ESM, dao-code 项目, vitest, ink-testing-library

## Global Constraints

- 注释与面向用户的输出一律中文;匹配周围代码的风格/缩进
- ES 模块导入必须加 `.js` 后缀(TS NodeNext 要求)
- 提交信息:Conventional Commits 风格,不加任何 AI/Claude 署名(用户全局规则)
- TDD:每个任务先写失败测试、验证失败原因正确、再写最小实现、验证通过
- 设计依据:`docs/superpowers/specs/2026-07-21-foreground-task-background-hotkey-design.md`(已提交,含"副作用核查"一节,本计划的技术细节以它为准,冲突时以本计划为准——本计划是对着实际代码核对过精确签名后写的)

---

### Task 1: `ForegroundRegistry` —— 前台调用注册表

**Files:**
- Create: `src/tui/foreground_registry.ts`
- Test: `src/tui/foreground_registry.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  ```ts
  export interface ForegroundRegistry {
    register(id: string, convert: () => void): void;
    unregister(id: string): void;
    convertAll(): number; // 触发所有已注册回调,返回触发的数量
  }
  export function createForegroundRegistry(): ForegroundRegistry;
  ```
  后续任务(Task 3 的 index.ts 装配、Task 4 的 exec_shell.ts、Task 5 的 agent.ts)都 import 这两个符号。

- [ ] **Step 1: 写失败测试**

```ts
// src/tui/foreground_registry.test.ts
import { describe, it, expect } from "vitest";
import { createForegroundRegistry } from "./foreground_registry.js";

describe("ForegroundRegistry", () => {
  it("convertAll 触发所有已注册的回调,返回触发数量", () => {
    const reg = createForegroundRegistry();
    let a = 0, b = 0;
    reg.register("id-a", () => { a++; });
    reg.register("id-b", () => { b++; });
    const n = reg.convertAll();
    expect(n).toBe(2);
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it("没有注册任何调用时,convertAll 返回 0、不报错", () => {
    const reg = createForegroundRegistry();
    expect(reg.convertAll()).toBe(0);
  });

  it("unregister 之后该项不再被 convertAll 触发", () => {
    const reg = createForegroundRegistry();
    let called = 0;
    reg.register("id-a", () => { called++; });
    reg.unregister("id-a");
    expect(reg.convertAll()).toBe(0);
    expect(called).toBe(0);
  });

  it("convertAll 之后注册表清空,连续按两次不会对同一批任务重复触发", () => {
    const reg = createForegroundRegistry();
    let called = 0;
    reg.register("id-a", () => { called++; });
    reg.convertAll();
    expect(reg.convertAll()).toBe(0);
    expect(called).toBe(1);
  });

  it("同一个 id 重复 register 会覆盖旧回调,不是叠加两个", () => {
    const reg = createForegroundRegistry();
    const calls: string[] = [];
    reg.register("id-a", () => calls.push("old"));
    reg.register("id-a", () => calls.push("new"));
    reg.convertAll();
    expect(calls).toEqual(["new"]);
  });
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `npx vitest run src/tui/foreground_registry.test.ts`
Expected: FAIL,报错找不到模块 `./foreground_registry.js`(文件还不存在)

- [ ] **Step 3: 写最小实现**

```ts
// src/tui/foreground_registry.ts
// 前台调用注册表:Bash(exec_shell.ts)/Agent(agent.ts)前台路径开始时各自注册一个
// "转后台"回调,结束(正常/异常)时反注册。Ctrl+B 按下时(App.tsx)遍历触发全部回调,
// 一次按键把本回合内所有还在前台跑着的调用一起转后台——不做"选哪个"的选择 UI(设计文档
// §明确排除的范围)。跟 ESC 用的顶层 AbortController 是两套独立机制,互不影响。
export interface ForegroundRegistry {
  register(id: string, convert: () => void): void;
  unregister(id: string): void;
  convertAll(): number;
}

export function createForegroundRegistry(): ForegroundRegistry {
  const entries = new Map<string, () => void>();
  return {
    register(id, convert) {
      entries.set(id, convert);
    },
    unregister(id) {
      entries.delete(id);
    },
    convertAll() {
      const callbacks = [...entries.values()];
      entries.clear();
      for (const cb of callbacks) cb();
      return callbacks.length;
    },
  };
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `npx vitest run src/tui/foreground_registry.test.ts`
Expected: 5 个测试全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/tui/foreground_registry.ts src/tui/foreground_registry.test.ts
git commit -m "feat(tui): 新增前台调用注册表(Ctrl+B 转后台的公共基础设施)"
```

---

### Task 2: `processManager.adopt()` —— 接管已在跑的前台 Bash 子进程

**Files:**
- Modify: `src/tools/process_manager.ts`
- Test: `src/tools/process_manager.test.ts`(若不存在则新建)

**Interfaces:**
- Consumes: 无(`ChildProcess` 由调用方——Task 4 的 exec_shell.ts——传入,不是 processManager 自己 spawn 的)
- Produces:
  ```ts
  adopt(child: ChildProcess, command: string, cwd: string, buffered: { stdout: string; stderr: string }): string; // 返回 proc id,格式同 start() 的 "proc-N"
  ```
  Task 4 依赖这个方法名、参数顺序、返回值格式。

**背景(为什么不能直接把 child 塞进 `procs` map 了事)**:`start()` 的子进程 spawn 时 `stdio` 直接落文件(`stdoutPath`/`stderrPath`),`poll()` 靠 `readNewBytes` 读文件增量。但前台路径(`exec_shell.ts` 的 `runForeground`)spawn 时用的是默认 pipe(`child.stdout?.on("data", ...)` 累积到内存字符串),不是文件。`adopt()` 要把"已经用 pipe 在跑的 child"接管成"文件支撑的 BgProc",这样 `poll()`/`kill()`/退出通知这些既有逻辑完全不用改,只需要在 `adopt()` 内部做一次"引导写入 + 后续增量追加到同一批文件"。

- [ ] **Step 1: 写失败测试(用真实 spawn 的子进程,不 mock child_process——要验证真实效果)**

```ts
// src/tools/process_manager.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { processManager } from "./process_manager.js";

describe("processManager.adopt", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "dao-adopt-"));
    processManager.reset();
  });

  it("接管一个已经在跑、已经产出过部分输出的真实子进程,poll() 能读到引导内容 + 后续新增内容", async () => {
    const child = spawn("sh", ["-c", "echo before-adopt; sleep 0.3; echo after-adopt; sleep 0.3; echo done"], { cwd });
    let buffered = "";
    child.stdout!.on("data", (d) => { buffered += d.toString(); });
    // 等到 "before-adopt" 真的写出来了再接管(模拟:命令已经跑了一阵子,用户这时按了 Ctrl+B)
    await new Promise<void>((resolve) => {
      const check = setInterval(() => { if (buffered.includes("before-adopt")) { clearInterval(check); resolve(); } }, 20);
    });
    child.stdout!.removeAllListeners("data"); // 模拟 exec_shell.ts 转交前先摘掉自己的监听器

    const id = processManager.adopt(child, "echo ...", cwd, { stdout: buffered, stderr: "" });
    expect(id).toMatch(/^proc-\d+$/);

    // 等子进程真正跑完
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    await new Promise((r) => setTimeout(r, 50)); // 给 "exit" 后的异步文件写入一点缓冲时间

    const result = processManager.poll(id);
    expect(result.stdout).toContain("before-adopt"); // 引导内容(接管前已经产出的)
    expect(result.stdout).toContain("after-adopt"); // 接管后新增的内容也要读得到
    expect(result.stdout).toContain("done");
    expect(result.status).toBe("exited");
    expect(result.exitCode).toBe(0);
  });

  it("接管后可以用 kill() 正常终止", async () => {
    const child = spawn("sh", ["-c", "sleep 5"], { cwd, detached: true });
    const id = processManager.adopt(child, "sleep 5", cwd, { stdout: "", stderr: "" });
    processManager.kill(id);
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    const result = processManager.poll(id);
    expect(result.status).toBe("exited");
  });
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `npx vitest run src/tools/process_manager.test.ts`
Expected: FAIL,`processManager.adopt is not a function`

- [ ] **Step 3: 写最小实现**

在 `src/tools/process_manager.ts` 里,`import` 段加 `appendFileSync, writeFileSync`:

```ts
import { openSync, closeSync, readSync, statSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
```

在 `class ProcessManager` 内、`start()` 方法之后新增 `adopt()`:

```ts
  // 接管一个【已经在跑】的前台子进程(不是自己 spawn 的)—— Ctrl+B 转后台用。
  // 前台路径(exec_shell.ts runForeground)用 pipe 收集输出到内存字符串,跟 start() 的落文件方式不同;
  // 这里做一次性引导写入(把接管前已经攒下的 buffered 内容写进文件)+ 后续增量追加到同一批文件,
  // 这样接管完成后这个进程在 poll()/kill()/退出通知上跟 start() 建的进程完全同构,不用改那些逻辑。
  adopt(child: ChildProcess, command: string, cwd: string, buffered: { stdout: string; stderr: string }): string {
    const id = `proc-${++this.counter}`;
    const logDir = path.join(cwd, ".dao", "bg", id);
    mkdirSync(logDir, { recursive: true });
    const stdoutPath = path.join(logDir, "stdout.log");
    const stderrPath = path.join(logDir, "stderr.log");
    // 引导写入:接管前已经产出、只存在于调用方内存里的那部分输出,先落盘,不然这部分内容永久丢失。
    writeFileSync(stdoutPath, buffered.stdout);
    writeFileSync(stderrPath, buffered.stderr);
    const proc: BgProc = {
      id, command, child, stdoutPath, stderrPath,
      stdoutOffset: Buffer.byteLength(buffered.stdout),
      stderrOffset: Buffer.byteLength(buffered.stderr),
      status: "running",
      exitCode: null,
      signal: null,
      notified: false,
    };
    // 接管后的新增输出:直接追加写文件(调用方在过继前应该已经摘掉自己的 "data" 监听器,
    // 见 exec_shell.ts 的过继逻辑;这里只管接手之后的部分,不关心过继前谁在监听)。
    child.stdout?.on("data", (d: Buffer) => appendFileSync(stdoutPath, d));
    child.stderr?.on("data", (d: Buffer) => appendFileSync(stderrPath, d));
    child.on("exit", (code, signal) => {
      proc.status = "exited";
      proc.exitCode = code;
      proc.signal = signal;
      if (!proc.notified) {
        proc.notified = true;
        this.notifications.push(shellNotificationXml(id, command, code, signal));
        this.notify();
      }
    });
    this.procs.set(id, proc);
    return id;
  }
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `npx vitest run src/tools/process_manager.test.ts`
Expected: 2 个测试全部 PASS

- [ ] **Step 5: 运行 typecheck**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add src/tools/process_manager.ts src/tools/process_manager.test.ts
git commit -m "feat(tools): processManager 支持接管已在跑的前台子进程(adopt)"
```

---

### Task 3: 把注册表接进 `ToolContext` / `AppDeps` / App.tsx 的 Ctrl+B

**Files:**
- Modify: `src/tools/types.ts`
- Modify: `src/index.ts`
- Modify: `src/tui/app/types.ts`
- Modify: `src/tui/app/App.tsx`
- Modify: `src/i18n/messages/zh.ts`
- Modify: `src/i18n/messages/en.ts`
- Test: `src/tui/app/App.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `createForegroundRegistry`/`ForegroundRegistry`
- Produces: `ToolContext.foregroundRegistry?: ForegroundRegistry`(Task 4/5 消费)、`AppDeps.convertForegroundToBackground?: () => number`

这一步先只打通"按键 → 触发注册表 → UI 提示"这条链路,用手工构造的假回调验证;Bash/Agent 真正往注册表里注册东西是 Task 4/5 的事。

- [ ] **Step 1: `ToolContext` 加字段**

在 `src/tools/types.ts` 里 `taskManager?: TaskManager;` 那一行(第 79 行)之后加:

```ts
  // 前台调用(Bash/Agent)注册表:Ctrl+B 转后台用。同一回合内的工具 handler 共享同一个实例
  // (由 loop.ts 的 toolCtx 浅拷贝下发)。未注入 = 不支持转后台(如子代理自己的 ToolContext、测试环境)。
  foregroundRegistry?: import("../tui/foreground_registry.js").ForegroundRegistry;
```

- [ ] **Step 2: index.ts 装配**

在 `src/index.ts` 里找到长寿 `ctx` 对象的装配处(`taskManager` 字段所在的那次对象字面量,搜索 `taskManager:` 定位),加一行:

```ts
    foregroundRegistry: createForegroundRegistry(),
```

并在文件顶部 import 区加:

```ts
import { createForegroundRegistry } from "./tui/foreground_registry.js";
```

同时找到组装 `AppDeps`(传给 `<App deps={...} />` 或等价的 `submit`/`getStatus` 那个对象字面量)的地方,加:

```ts
    convertForegroundToBackground: () => ctx.foregroundRegistry!.convertAll(),
```

(用你在 index.ts 里已经引用长寿 `ctx` 的那个变量名替换上面的 `ctx`——找 `taskManager:` 出现的那次对象字面量所在作用域,变量名以实际代码为准。)

- [ ] **Step 3: `AppDeps` 类型加字段**

在 `src/tui/app/types.ts` 的 `runningShells?: () => number;` 那一行(第 77 行)之后加:

```ts
  // Ctrl+B:把当前正在前台跑的调用(Bash/Agent)转成后台。返回本次触发转后台的数量
  // (供 App 决定要不要提示;0 = 没有前台调用在跑,静默不提示)。省略则不绑定这个快捷键。
  convertForegroundToBackground?: () => number;
```

- [ ] **Step 4: i18n key**

在 `src/i18n/messages/zh.ts` 里 `"ui.notice.steeringCancelled":` 那一行之后加:

```ts
  "ui.notice.convertedToBackground": "已将 {0} 个前台调用转为后台,完成后会自动通知你。",
```

在 `src/i18n/messages/en.ts` 对应位置加:

```ts
  "ui.notice.convertedToBackground": "Converted {0} foreground call(s) to background; you'll be notified when they finish.",
```

- [ ] **Step 5: 写失败测试(App.tsx Ctrl+B 行为)**

```ts
// 追加到 src/tui/app/App.test.tsx(找一个已有 describe("App", ...) 块内合适位置插入)
  it("Ctrl+B:有前台调用时触发转后台并提示数量", async () => {
    let convertCalls = 0;
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        submit: async () => new Promise(() => {}), // 模拟一直不 resolve 的进行中回合(busy=true)
        convertForegroundToBackground: () => { convertCalls++; return 2; },
      })} />,
    );
    for (const ch of "go") stdin.write(ch);
    await delay();
    stdin.write("\r"); // 提交,进入 busy
    await delay();
    stdin.write("\x02"); // Ctrl+B
    await delay();
    expect(convertCalls).toBe(1);
    const f = lastFrame()!;
    expect(f).toContain("已将 2 个前台调用转为后台");
  });

  it("Ctrl+B:没有前台调用在跑(convertForegroundToBackground 返回 0)时不提示、不报错", async () => {
    let convertCalls = 0;
    const { lastFrame, stdin } = render(
      <App {...makeDeps({
        submit: async () => new Promise(() => {}),
        convertForegroundToBackground: () => { convertCalls++; return 0; },
      })} />,
    );
    for (const ch of "go") stdin.write(ch);
    await delay();
    stdin.write("\r");
    await delay();
    stdin.write("\x02");
    await delay();
    expect(convertCalls).toBe(1);
    expect(lastFrame()!).not.toContain("转为后台");
  });

  it("Ctrl+B:不在 busy 状态时(没有回合在跑)不触发", async () => {
    let convertCalls = 0;
    const { stdin } = render(
      <App {...makeDeps({ convertForegroundToBackground: () => { convertCalls++; return 1; } })} />,
    );
    stdin.write("\x02"); // 还没提交任何回合,busy=false
    await delay();
    expect(convertCalls).toBe(0);
  });
```

- [ ] **Step 6: 运行测试,确认失败**

Run: `npx vitest run src/tui/app/App.test.tsx -t "Ctrl\+B"`
Expected: 前两个测试 FAIL(提示文本没出现/`convertCalls` 仍为 0,因为 App.tsx 还没有 Ctrl+B 处理逻辑);第三个测试本来就该 PASS(可以先确认它意外通过,属于正常现象,不代表实现完成)。

- [ ] **Step 7: App.tsx 实现**

在 `src/tui/app/App.tsx` 里,找到 Ctrl+O 处理块结尾(`if (key.ctrl && ch === "o") { ... return; }`,大致在第 876-884 行),紧接着、在 `if (busy) {` 那个大分支(第 886 行)**之前**插入:

```ts
    // Ctrl+B:把当前正在前台跑的调用(Bash/Agent)转成后台,主循环立刻恢复响应。
    // 跟 ESC 一样只在有回合在跑(busy)时才有意义;没有前台调用时 convertForegroundToBackground
    // 返回 0,静默不提示——不是"这个键没反应",是"确实没有能转的东西"。
    if (key.ctrl && ch === "b" && busy && deps.convertForegroundToBackground) {
      const n = deps.convertForegroundToBackground();
      if (n > 0) pushItem({ id: nextId(), kind: "notice", text: t("ui.notice.convertedToBackground", n) });
      return;
    }
```

- [ ] **Step 8: 运行测试,确认通过**

Run: `npx vitest run src/tui/app/App.test.tsx -t "Ctrl\+B"`
Expected: 3 个测试全部 PASS

- [ ] **Step 9: 运行 typecheck + 全量 App 测试**

Run: `npm run typecheck && npx vitest run src/tui/app/App.test.tsx`
Expected: 无错误,全部 PASS(确认没有破坏其它按键测试)

- [ ] **Step 10: 提交**

```bash
git add src/tools/types.ts src/index.ts src/tui/app/types.ts src/tui/app/App.tsx src/i18n/messages/zh.ts src/i18n/messages/en.ts src/tui/app/App.test.tsx
git commit -m "feat(tui): Ctrl+B 转后台快捷键接线(注册表→AppDeps→按键处理)"
```

---

### Task 4: `exec_shell.ts` 前台 Bash 命令接入转后台

**Files:**
- Modify: `src/tools/exec_shell.ts`
- Test: `src/tools/exec_shell.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ForegroundRegistry`(经 `ctx.foregroundRegistry`)、Task 2 的 `processManager.adopt()`
- Produces: 无新导出;`runForeground` 的行为变化(多接受一个可选注册表 + id 参数)

**关键改动点(设计文档 §组件 1 的精确落地)**:
1. `runForeground` 需要多两个参数:`registry: ForegroundRegistry | undefined` 和一个稳定的调用 id(用 `crypto.randomUUID()` 现场生成即可,不需要复用其它 id 空间)。
2. 前台调用开始时 `registry?.register(id, convert)`;`finish()` 里(无论正常结束/超时/中断)都要 `registry?.unregister(id)`。
3. `convert` 回调要做:①解绑 `ctx.signal` 上原来的 `onAbort` 监听器(避免新旧两套终止路径打架,见设计文档副作用核查);②调 `processManager.adopt(child, command, cwd, { stdout, stderr })`;③清掉 `timer`(前台超时定时器);④提前 `resolve` 出"已转后台"的结果(复用 `finish`/`resolve` 那个 Promise,但走一条不同的分支,不是走 `finish(code)` 那条——因为进程还没退出,没有 `code`)。

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 src/tools/exec_shell.test.ts
import { createForegroundRegistry } from "../tui/foreground_registry.js";
import { processManager } from "./process_manager.js";

describe("Bash 前台命令 Ctrl+B 转后台", () => {
  it("注册表触发转后台回调后,工具调用立即返回已转后台文本,不等命令跑完", async () => {
    const registry = createForegroundRegistry();
    processManager.reset();
    const start = Date.now();
    const resultPromise = execShellTool.handler(
      { command: "sleep 5 && echo done" } as any,
      { workspaceRoot: process.cwd(), foregroundRegistry: registry } as any,
    );
    // 等一小段时间确保命令已经真正 spawn 起来,再模拟用户按 Ctrl+B
    await new Promise((r) => setTimeout(r, 100));
    const n = registry.convertAll();
    expect(n).toBe(1);
    const result = await resultPromise;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(4000); // 没有傻等 5 秒
    expect(result).toContain("已转后台");
    expect(processManager.runningCount()).toBe(1); // 进程被 processManager 接管、还在跑
    processManager.reset(); // 清理:杀掉这个测试起的进程
  });

  it("命令跑得很快、自己结束了之后,注册表里已经没有它了(convertAll 触发不到)", async () => {
    const registry = createForegroundRegistry();
    const result = await execShellTool.handler(
      { command: "echo fast" } as any,
      { workspaceRoot: process.cwd(), foregroundRegistry: registry } as any,
    );
    expect(result).toContain("fast");
    expect(registry.convertAll()).toBe(0); // 已经在 finish() 里反注册了
  });
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `npx vitest run src/tools/exec_shell.test.ts -t "Ctrl\+B"`
Expected: FAIL——第一个测试里 `result` 不含"已转后台"(现在 handler 根本不认识 `ctx.foregroundRegistry`,会傻等 5 秒真正跑完);超时或断言不符都算预期的失败。

- [ ] **Step 3: 实现**

在 `src/tools/exec_shell.ts` 顶部 import 区加:

```ts
import { randomUUID } from "node:crypto";
import type { ForegroundRegistry } from "../tui/foreground_registry.js";
```

修改 `runForeground` 签名和函数体(原第 58-137 行)。新签名多两个参数(放在末尾,可选,不破坏其它调用方):

```ts
function runForeground(
  command: string,
  cwd: string,
  timeout: number,
  signal?: AbortSignal,
  disableSandbox?: boolean,
  headless?: boolean,
  registry?: ForegroundRegistry,
): Promise<ForegroundResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let aborted = false;
    let timedOut = false;
    let done = false;
    let stdout = "";
    let stderr = "";
    let capped = false;
    const sb = sandboxSpawn(command, cwd, disableSandbox);
    if (sb && "error" in sb) { resolve({ stdout: "", stderr: `沙箱不可用:${sb.error}`, code: 1, aborted: false, timedOut: false, elapsedMs: 0 }); return; }
    const child = sb
      ? spawn(sb.file, sb.args, { cwd, detached: true, env: scrubbedEnv() })
      : spawn(command, { cwd, shell: true, detached: true, env: scrubbedEnv() });
    if (headless) child.stdin?.end();
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try { child.kill(sig); } catch {}
      }
    };
    const append = (buf: Buffer, which: "o" | "e") => {
      if (capped) return;
      const s = buf.toString();
      if (which === "o") stdout += s; else stderr += s;
      if (stdout.length + stderr.length > OUT_CAP) { capped = true; killGroup("SIGTERM"); }
    };
    const onStdout = (d: Buffer) => append(d, "o");
    const onStderr = (d: Buffer) => append(d, "e");
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    const timer = timeout > 0 ? setTimeout(() => { timedOut = true; killGroup("SIGTERM"); }, timeout) : undefined;
    function onAbort() { aborted = true; killGroup("SIGTERM"); }
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    let exitGraceTimer: ReturnType<typeof setTimeout> | undefined;
    let exitCode: number | null = null;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      registry?.unregister(regId);
      clearTimeout(timer!);
      if (exitGraceTimer) clearTimeout(exitGraceTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (capped) stderr += "\n[输出超过 10MB 上限被截断,请用更精确的命令或重定向到文件后再 grep/Read]";
      resolve({ stdout, stderr, code, timedOut, aborted, elapsedMs: Date.now() - startTime });
    };
    child.on("error", (e) => { stderr += String((e as Error).message ?? e); finish(1); });
    child.on("close", (code) => finish(typeof code === "number" ? code : (exitCode ?? 1)));
    child.on("exit", (code) => {
      exitCode = typeof code === "number" ? code : 1;
      exitGraceTimer = setTimeout(() => finish(exitCode!), 300);
    });

    // Ctrl+B 转后台:注册一个 id + 回调,回合发起方(App.tsx)按键时触发。
    const regId = randomUUID();
    registry?.register(regId, () => {
      if (done) return; // 命令恰好在这一瞬间自然结束了,race 由 finish() 的 done 标志位保证只 settle 一次
      done = true;
      clearTimeout(timer!);
      // 解绑原来的 abort 监听器:过继之后,终止这个进程的唯一入口应该是 KillShell(processManager
      // 生命周期管),不能让这条 ctx.signal 上的旧 onAbort 继续认领"我负责杀它"(设计文档副作用核查)。
      if (signal) signal.removeEventListener("abort", onAbort);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      const id = processManager.adopt(child, command, cwd, { stdout, stderr });
      resolve({ stdout: `已转后台(id=${id})。进程完成后会自动通知你——做完别的事后可以用 BashOutput 看一眼进度趋势,发现异常用 KillShell 终止。`, stderr: "", code: 0, aborted: false, timedOut: false, elapsedMs: Date.now() - startTime });
    });
  });
}
```

在 `handler` 里调用 `runForeground` 那一行(原第 262 行附近),补上 `ctx.foregroundRegistry`:

```ts
    const r = await runForeground(args.command, (ctx.cwd ?? ctx.workspaceRoot), args.timeout ?? 0, ctx.signal, args.dangerouslyDisableSandbox, ctx.headless, ctx.foregroundRegistry);
```

`ForegroundResult` 走到后面拼返回文案那段逻辑(原 `parts.push(...)`)对"已转后台"这种 `code===0` 且没有真正超时/中断标记的结果要能直接把 `stdout` 原样透出——检查一下现有拼接逻辑,如果它还会额外拼接 `[exit 0,运行 Xs]` 之类的后缀,加一个特判:`r.stdout.startsWith("已转后台")` 时直接 `return r.stdout`,不走常规的 parts 拼接(这段视现有代码实际结构调整,原则是:转后台的返回文案要跟 `background:true` 那条(`exec_shell.ts:248` 附近)风格一致、干净利落,不要混进"运行了多久/退出码"这类不再适用的前台专属信息)。

- [ ] **Step 4: 运行测试,确认通过**

Run: `npx vitest run src/tools/exec_shell.test.ts`
Expected: 全部 PASS(含新增的 2 个 + 原有全部用例)

- [ ] **Step 5: typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: 无错误(lint 允许已有的预存 warning,不能新增)

- [ ] **Step 6: 提交**

```bash
git add src/tools/exec_shell.ts src/tools/exec_shell.test.ts
git commit -m "feat(tools): Bash 前台命令接入 Ctrl+B 转后台(过继给 processManager)"
```

---

### Task 5: `agent.ts` 前台子代理调用接入转后台

**Files:**
- Modify: `src/tools/agent.ts`
- Test: `src/tools/agent.test.ts`(若不存在则新建,参考 `src/agent/runAgent.test.ts` 里 stub streamChat 的写法)

**Interfaces:**
- Consumes: Task 1 的 `ForegroundRegistry`(经 `ctx.foregroundRegistry`)、`ctx.taskManager.registerAsyncAgent`/`runAsyncAgentLifecycle`(已有,agent.ts 后台分支已在用)
- Produces: 无新导出;`runOne` 内前台分支的行为变化

**关键改动点(设计文档 §组件 2 的精确落地,对应 agent.ts:280-328 现有代码)**:
1. `for await (const m of runAgent({...}))` 改成具名生成器 `const gen = runAgent({...});`,手动 `while` 循环 + `Promise.race` 消费,这样才有句柄能在外部触发时调 `gen.return()`。
2. 注册表回调只做一件事:resolve 一个"转后台信号" Promise,让 race 的另一支赢过 `gen.next()`。
3. race 判定"转后台"分支触发时,按顺序:①`abortController.abort()`(级联杀掉子代理当前卡着的嵌套前台调用);②`await` 带超时保护的 `gen.return(undefined)`(让 `finally` 里的 hooks/MCP 清理跑完);③`ctx.taskManager.settle(fg.taskId)`(前台生命周期结束);④用已产出的 `messages` 当 `forkContextMessages`(不能当 `promptMessages`,否则会在已有的 system 消息前面再叠一条新 system 消息——见下方"reseed 参数"），`promptMessages: []`，复用 `worktree?.root`/`reqModel`/`reqMode`/`fork` 这些原调用参数，仿照 agent.ts 现成的后台分支(252-275 行)调 `registerAsyncAgent` + `runAsyncAgentLifecycle`。

- [ ] **Step 1: 写失败测试**

参考 `src/agent/runAgent.test.ts` 里 `baseParams`/stub `streamChat` 的写法(该文件已有对 `runAgent` 的直接单测,这里测的是 `agent.ts` 这一层,用一个可控的假 `ctx.runAgent` 更直接,不需要真的驱动 LLM 调用):

```ts
// src/tools/agent.test.ts(新建)
import { describe, it, expect } from "vitest";
import { agentTool } from "./agent.js";
import { createForegroundRegistry } from "../tui/foreground_registry.js";
import { createTaskManager } from "../agent/tasks.js";
import type { AgentDef } from "../agent/agent_defs.js";
import type { ChatMessage } from "../client/types.js";

const genericAgentDef: AgentDef = {
  agentType: "general-purpose",
  whenToUse: "",
  source: "built-in",
  getSystemPrompt: () => "SYS",
} as AgentDef;

describe("Agent 前台调用 Ctrl+B 转后台", () => {
  it("注册表触发转后台回调后:abort 先于 return 被调用、taskManager 拿到已产出消息重启一个异步任务、handler 立即返回已转后台文本", async () => {
    const registry = createForegroundRegistry();
    const taskManager = createTaskManager();
    let abortedAt = -1;
    let returnedAt = -1;
    let seq = 0;
    let neverResolves: () => void = () => {};
    const producedMessages: ChatMessage[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "do it" },
      { role: "assistant", content: "在做第一步" },
    ];

    async function* fakeRunAgent(params: any): AsyncGenerator<ChatMessage, void> {
      if (params.isAsync === false) {
        // 前台这一路:先产出几条消息,然后永远卡住,直到 abort/return
        for (const m of producedMessages) yield m;
        try {
          await new Promise<void>((resolve) => { neverResolves = resolve; });
        } finally {
          returnedAt = seq++;
        }
      } else {
        // 转后台重启这一路:立刻产出一条消息代表"续接成功"就结束
        expect(params.forkContextMessages).toEqual(producedMessages); // 复用已产出消息,不是 promptMessages
        expect(params.promptMessages).toEqual([]);
        yield { role: "assistant", content: "续接完成" };
      }
    }

    const result = await agentTool.handler(
      { task: "do it" } as any,
      {
        runAgent: fakeRunAgent as any,
        taskManager,
        agentDefinitions: [genericAgentDef],
        foregroundRegistry: registry,
      } as any,
    );
    // 上面这次 handler() 调用应该在转后台触发之前一直卡着(因为 fakeRunAgent 前台分支永不 resolve)。
    // 但 JS 是单线程的,await 表达式会让出控制权——用 Promise.race 配合一个短延迟来触发转后台。
    void result; // 占位,真正的断言在下方改写版本里(见 Step 1 备注)
  });
});
```

> **Step 1 备注(写测试时的真实做法,上面骨架里 `handler()` 直接 `await` 会卡死,需要调整成不阻塞主测试协程的写法)**:不要 `await agentTool.handler(...)` 后再操作 registry——`handler` 内部前台分支会一直挂起等 `neverResolves`,必须先发起调用拿到 Promise、不 await 它、等一小段时间(用 `await new Promise(r => setTimeout(r, 0))` 让出一次事件循环,确保 `runOne` 已经跑到 `registry.register(...)` 那一行)、再调 `registry.convertAll()`、最后再 `await` 这个 handler 的 Promise 拿最终返回值。把上面骨架改写为:
>
> ```ts
>     const resultPromise = agentTool.handler(
>       { task: "do it" } as any,
>       { runAgent: fakeRunAgent as any, taskManager, agentDefinitions: [genericAgentDef], foregroundRegistry: registry } as any,
>     );
>     await new Promise((r) => setTimeout(r, 20)); // 让 runOne 跑到 registry.register
>     const n = registry.convertAll();
>     expect(n).toBe(1);
>     const result = await resultPromise;
>     expect(result).toContain("已转后台");
>     expect(returnedAt).toBe(0); // gen.return() 的 finally 确实跑了
> ```
>
> 把这段替换掉骨架里 `void result;` 那一行往上的部分,组成完整测试。

- [ ] **Step 2: 运行测试,确认失败**

Run: `npx vitest run src/tools/agent.test.ts`
Expected: FAIL——`result` 不含"已转后台"(现在 `agentTool.handler` 根本不认识 `ctx.foregroundRegistry`,`for await` 会一直卡在 `neverResolves` 上,测试超时失败)

- [ ] **Step 3: 实现**

在 `src/tools/agent.ts` 顶部 import 区加:

```ts
import type { ForegroundRegistry } from "../tui/foreground_registry.js";
```

把原第 280-328 行(前台同步分支)整段替换为:

```ts
      if (!isolate && ctx.taskManager && taskManagerAdapter) {
        const fg = ctx.taskManager.registerAgentForeground({ agentId, description: t.slice(0, 50) });
        const { abortController } = fg;
        let detachParentAbort: (() => void) | undefined;
        if (ctx.signal) {
          if (ctx.signal.aborted) abortController.abort();
          else {
            const onParentAbort = () => abortController.abort();
            const parentSignal = ctx.signal;
            parentSignal.addEventListener("abort", onParentAbort, { once: true });
            detachParentAbort = () => parentSignal.removeEventListener("abort", onParentAbort);
          }
        }

        // Ctrl+B 转后台:注册一个"转后台信号"——收到信号时不再消费生成器,转走处理。
        let requestConvert: (() => void) | undefined;
        const convertSignal = new Promise<void>((resolve) => { requestConvert = resolve; });
        const registry: ForegroundRegistry | undefined = ctx.foregroundRegistry;
        registry?.register(agentId, () => requestConvert?.());

        const messages: ChatMessage[] = [];
        const gen = runAgent({
          agentDef, promptMessages, forkContextMessages, useExactTools: fork,
          isAsync: false, override: { agentId, abortController }, worktreePath: worktree?.root, model: reqModel, mode: reqMode,
          messageParent: (m) => { ctx.taskManager!.emitFromTask(fg.taskId, m); },
        });
        try {
          let converted = false;
          while (true) {
            const outcome = await Promise.race([
              gen.next().then((r) => ({ kind: "next" as const, r })),
              convertSignal.then(() => ({ kind: "convert" as const })),
            ]);
            if (outcome.kind === "convert") { converted = true; break; }
            if (outcome.r.done) break;
            messages.push(outcome.r.value);
          }
          registry?.unregister(agentId);

          if (converted) {
            // 先 abort:子代理这一刻如果正卡在自己的某次嵌套前台调用(比如它自己在跑一个 Bash
            // 命令),不 abort 的话那个嵌套调用会继续实际执行、继续计费,只是没人再读结果。
            abortController.abort();
            // 再 await(带超时保护)让生成器走完自己的 finally(注销 hooks、关 MCP 连接、摘监听器)。
            await Promise.race([
              gen.return(undefined),
              new Promise((resolve) => setTimeout(resolve, 5000)),
            ]);
            detachParentAbort?.();
            ctx.taskManager.settle(fg.taskId); // 前台生命周期结束,交棒给下面新起的异步任务

            const newAgentId = randomAgentId();
            const bg = ctx.taskManager.registerAsyncAgent({ agentId: newAgentId, description: t.slice(0, 50) });
            void runAsyncAgentLifecycle({
              taskId: bg.agentId,
              agentId: newAgentId,
              agentType: agentDef.agentType,
              isBuiltInAgent,
              prompt: t,
              model: resolvedModelForDisplay,
              // 复用已产出的 messages 当 forkContextMessages(不能当 promptMessages——那样会在
              // messages 里已经含有的 system 消息前面再叠一条新的 system 消息)。promptMessages
              // 传空数组;worktree/model/mode/fork 这些原调用参数原样复用,否则会跑错目录或让
              // fork 的前缀缓存对不齐(设计文档副作用核查)。
              makeStream: (onCacheSafeParams) => runAgent({
                agentDef, promptMessages: [], forkContextMessages: messages, useExactTools: fork,
                isAsync: true, override: { abortController: bg.abortController, agentId: newAgentId },
                worktreePath: worktree?.root, model: reqModel, mode: reqMode, onCacheSafeParams,
                messageParent: (m) => { ctx.taskManager!.emitFromTask(bg.agentId, m); },
              }),
              taskManager: taskManagerAdapter,
              classifyFn: ctx.handoffClassifyFn,
              permissionMode: ctx.permissionMode,
              abortSignal: bg.abortController.signal,
            });
            return `已转后台(${bg.agentId});完成后会自动通知你结果。你可以先继续别的事或结束本轮。`;
          }

          detachParentAbort?.();
          ctx.taskManager.settle(fg.taskId);
          const result = finalizeAgentTool(messages, agentId, {
            prompt: t, model: resolvedModelForDisplay, agentType: agentDef.agentType, startTime: Date.now(), isAsync: false, isBuiltInAgent,
          });
          let text = result.content.map((c) => c.text).join("\n") || "(子代理无最终输出)";
          if (ctx.handoffClassifyFn && ctx.permissionMode) {
            const warning = await classifyHandoffIfNeeded({
              agentMessages: [...promptMessages, ...messages], permissionMode: ctx.permissionMode,
              abortSignal: new AbortController().signal, subagentType: agentDef.agentType,
              totalToolUseCount: result.totalToolUseCount, classifyFn: ctx.handoffClassifyFn,
            });
            if (warning) text = `${warning}\n\n${text}`;
          }
          return finishWithWorktree(text, worktree);
        } catch (e) {
          registry?.unregister(agentId);
          detachParentAbort?.();
          ctx.taskManager.settle(fg.taskId, "failed");
          throw e;
        }
      }
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `npx vitest run src/tools/agent.test.ts`
Expected: PASS

- [ ] **Step 5: 跑一遍 agent.ts 相关的既有测试,确认没有回归**

Run: `npx vitest run src/tools/agent.test.ts src/agent/runAgent.test.ts src/agent/agent_lifecycle.test.ts`
Expected: 全部 PASS(尤其确认原有"前台正常跑完"、"前台异常抛错"这两条路径的既有用例——如果这两个文件里已经覆盖了这些场景——仍然通过,证明这次改动没有破坏正常路径,只是新增了转后台分支)

- [ ] **Step 6: typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: 无错误

- [ ] **Step 7: 提交**

```bash
git add src/tools/agent.ts src/tools/agent.test.ts
git commit -m "feat(tools): Agent 前台调用接入 Ctrl+B 转后台(abort+清理重启,对标 CC)"
```

---

### Task 6: 端到端验证(真实效果,不只是单元测试)

**Files:** 无代码改动,纯验证步骤

**目标:** 按用户明确要求("一定要针对我们想要的效果做好测试验证"),在完成上面几个任务、各自单测都过了之后,做一次贯穿全链路的真实验证——不是重新跑一遍已经写过的单元测试,是从"用户按下 Ctrl+B"这个动作出发,确认真实效果符合预期。

- [ ] **Step 1: 全量测试 + typecheck + lint**

Run: `npm run typecheck && npm run lint && npx vitest run`
Expected: 全部 PASS,0 错误(允许已存在的、跟本次改动无关的 pre-existing warning,不能有新增失败)

- [ ] **Step 2: 本地构建 + 安装**

Run: `npm run bundle:install`
Expected: 编译成功,`~/.local/bin/dao` 更新

- [ ] **Step 3: 真实验证 Bash 转后台**

用 Ink 测试之外的路径再确认一次真实 spawn 链路(不是重复 Task 4 已有的单测,是用真实编译出的二进制走一遍):写一个一次性 vitest 集成测试(测完可以留着,归进 Task 4 的测试文件也可以,但至少要跑一次并观察真实输出),用真实 `spawn` 起一个跑 10 秒左右的命令(如 `for i in $(seq 1 10); do echo tick $i; sleep 1; done`),通过 `execShellTool.handler` 以真实 `foregroundRegistry` 实例发起前台调用,2 秒后调用 `registry.convertAll()`,断言:①返回文本包含"已转后台";②`processManager.poll(id)` 能读到已经产出的 tick 输出;③再等几秒后 `processManager.poll(id).status` 变成 `"exited"`,能读到全部 10 个 tick——证明"转后台之后命令并没有被打断,是真的在后台跑完的",这是这个功能最核心的价值点,必须亲眼断言到。

- [ ] **Step 4: 真实验证 Agent 转后台**

跑一次 `src/tools/agent.test.ts` 里 Task 5 写的测试,额外加一个断言:转后台之后,`taskManager.get(newAgentId)`(或对应的查询方式)能查到这个任务,状态是 `"running"`(证明确实注册进了 taskManager,后续能被 `TaskOutput`/`TaskStop` 管理,不是一个游离在外部没人管的调用)。

- [ ] **Step 5: 记录验证结果**

如果 Step 3/4 的断言全部通过,在本任务的 commit message 里写清楚验证到的具体现象(不是"测试通过"这种空话,是"Bash 命令转后台后继续产出了 N 条 tick 输出,最终 exitCode=0""Agent 转后台后 taskManager 里能查到新任务处于 running 状态"这种具体断言内容),供后续排查问题时对照。

- [ ] **Step 6: 提交(如 Step 3/4 产生了新文件/新测试用例)**

```bash
git add -A
git commit -m "test: 前台任务转后台端到端验证(真实子进程/真实子代理续接)"
```

---

## Self-Review 记录(写完计划后做的检查)

- **spec 覆盖**:设计文档的组件 1(Bash)→ Task 4;组件 2(Agent)→ Task 5;组件 3(注册表)→ Task 1+3;用户反馈(确认提示)→ Task 3;边界情况(无前台调用/headless/background:true 本来就跳过)→ Task 3 的测试 3 覆盖"不在 busy 时不触发",background:true 路径天然不注册(Task 4/5 的注册只发生在前台分支代码路径里,不需要额外测试证明"背景路径不受影响"——它们是完全独立的代码分支);副作用核查三条(先 abort 再 return、reseed 带全参数、Bash 过继解绑旧监听器)→ Task 5/4 的实现步骤逐条对应。测试策略→ Task 6。
- **占位符扫描**:未发现 TBD/TODO/"类似 Task N"这类描述;Task 5 的测试写了一段"备注"说明骨架需要改写,已经把改写后的完整代码写清楚,不是留白。
- **类型一致性**:`ForegroundRegistry.register(id: string, convert: () => void)` 在 Task 1 定义、Task 4/5 原样使用;`processManager.adopt(child, command, cwd, buffered)` 参数顺序在 Task 2 定义、Task 4 原样调用;`AppDeps.convertForegroundToBackground` 在 Task 3 定义、类型与 Task 3 测试里的 mock 一致。
- **已核实,不是遗留风险**:`messages` 数组末尾恰好是一条"有 tool_calls 但没配对 tool 结果"的 assistant 消息(转后台那一刻子代理正好卡在工具调用中途)会不会导致 API 400——核对过 `runAgent.ts:268-269`,`forkContextMessages` 在 runAgent 内部无条件过一遍 `filterIncompleteToolCalls`(`resume_agent.js` 导出,fork 路径本来就这么用),Task 5 的 reseed 走的正是 `forkContextMessages` 这条参数,天然复用这层过滤,不需要在 `makeStream` 里额外处理。
