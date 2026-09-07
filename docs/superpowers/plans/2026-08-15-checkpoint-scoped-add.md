# 影子 Git 快照:精确路径抢救,不再全树扫描 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"影子 git 快照"从"每回合无条件对整个工作区 `git add -A`"改成"只对 DAO 自己 Edit/Write 过的精确路径做增量抢救",消除 O(工作区大小) 的阻塞代价,同时保留 `/rewind` 的正确性(含 Bash/exec 改动的兜底保护)。

**Architecture:** `Checkpointer` 从"一次性全树快照"改成"写前抢救原始内容(`captureOriginal`,精确路径,便宜)+ 回合边界封存(`snapshot`,只重新 add 已知路径,依然便宜)+ Bash/exec 兜底(`captureOriginalFull`,退化全量 `add -A`,仍受硬超时保护,但只在真的跑了 Bash/exec 时才触发,不再是每回合必付的代价)"三段式。执行链路上,`src/tools/execute.ts` 在真正派发工具之前,按 capability 调用对应的抢救方法;`src/index.ts` 把 `Checkpointer` 的方法接到 `ToolContext.checkpointTrack` 上。`snapshot()` 的三个调用点(`src/index.ts:1679/2016/2239`)签名不变,内部实现改变,调用方无感知。

**Tech Stack:** TypeScript, Node `child_process.execFileSync`(已有硬超时,本计划复用不重开),Vitest。

## Global Constraints

- 不改变现有三个 `ckpt.snapshot(label)` 调用点的调用方式(`src/index.ts:1679/2016/2239`)——签名保持 `snapshot(label: string): string | null`。
- 不移除已有的 `HARD_TIMEOUT_MS` execFileSync 超时保护(`src/session/checkpoint.ts` 现有实现),`captureOriginalFull` 复用同一个 `run()` helper。
- Bash/exec 触发的改动仍必须被 `/rewind` 保护到(不能静默丢失覆盖面),但只在【真的执行了 Bash/exec 调用】时才付全树扫描的代价,不再是每回合无条件付。
- `everTouched` 路径集合按会话生命周期维护在 `Checkpointer` 实例内部(闭包状态),不落盘、不跨进程持久化。
- 每个任务完成后跑 `npx vitest run <相关目录>` + `npx tsc --noEmit`,两者都过才能进入下一个任务。

---

## File Structure

- **Modify** `src/session/checkpoint.ts`:`Checkpointer` 接口新增 `captureOriginal`/`captureOriginalFull`/`consumeSlowNotice`;`snapshot()` 改成只重新 add 已知路径;新增 `everTouched: Set<string>` 内部状态;初始化时补一个空的 init 提交(供第一次 `captureOriginal` 有提交可 amend)。
- **Modify** `src/session/checkpoint.test.ts`:改写覆盖新语义的用例,新增"精确路径抢救不扫全树"与"Bash 兜底仍受硬超时保护"两个场景。
- **Modify** `src/tools/types.ts`:`ToolContext` 新增可选字段 `checkpointTrack`。
- **Modify** `src/tools/execute.ts`:`dispatchOne` 里,真正派发工具之前按 capability 调用 `ctx.checkpointTrack`。
- **Modify** `src/tools/execute.test.ts`(如存在,需确认):补一个"write 工具执行前调用了 captureOriginal"的用例。
- **Modify** `src/index.ts`:接线 `ctx.checkpointTrack`;`submit` 里 `ckpt.consumeSlowNotice()` 触发时给用户一条可见提示。

---

### Task 1: Checkpointer 核心——everTouched 追踪 + captureOriginal(精确路径抢救)

**Files:**
- Modify: `src/session/checkpoint.ts`
- Test: `src/session/checkpoint.test.ts`

**Interfaces:**
- Produces: `Checkpointer.captureOriginal(paths: string[]): void` —— 对每个"这个 session 里第一次被传进来"的路径,如果它当前在磁盘上存在,把它现在的内容(修改前的原始内容)`git add` 进索引并 `git commit --amend --no-edit --no-verify` 补进"当前回合开始时"那个已经封存的提交里;已经抢救过的路径直接跳过(`everTouched` 命中即返回,O(1))。若路径不存在(即将被新建的文件),只记入 `everTouched`,不做 git 操作(没有"原始内容"要保护)。
- Consumes: 内部沿用现有 `run(args)` helper(`execFileSync` + `HARD_TIMEOUT_MS`,已在上一轮修复里加好,本任务不改)。

- [ ] **Step 1: 写失败测试——captureOriginal 精确抢救 + amend 进已封存提交**

在 `src/session/checkpoint.test.ts` 顶部 `import` 后新增(替换原有第一个 `it` 用例前的位置即可,先加不删):

```ts
describe("Checkpointer.captureOriginal(精确路径抢救)", () => {
  it("captureOriginal 抢救的原始内容,能在更早的 snapshot 里被 restore 出来", () => {
    const a = path.join(root, "a.txt");
    writeFileSync(a, "original");
    const cp = createCheckpointer(root);

    const ref0 = cp.snapshot("before turn1"); // 回合开始:a 还没被碰过
    expect(ref0).toBeTruthy();

    cp.captureOriginal(["a.txt"]); // 编辑 a 之前:抢救原始内容(amend 进 ref0 对应的提交)
    writeFileSync(a, "edited-by-turn1"); // 真正的编辑

    const ref1 = cp.snapshot("before turn2"); // 下一回合开始:把 a 的最新内容重新封存
    expect(ref1).toBeTruthy();

    writeFileSync(a, "edited-by-turn2");

    // restore 到"before turn2"(ref1):a 应该是 turn1 编辑后、turn2 编辑前的内容
    expect(cp.restore(ref1!)).toBe(true);
    expect(readFileSync(a, "utf8")).toBe("edited-by-turn1");

    // restore 到"before turn1"(ref0,内容已被 amend 抢救):a 应该是最原始的内容
    expect(cp.restore(ref0!)).toBe(true);
    expect(readFileSync(a, "utf8")).toBe("original");
  });

  it("captureOriginal 对同一路径只抢救一次(第二次调用不重复 add/amend)", () => {
    const a = path.join(root, "a.txt");
    writeFileSync(a, "v1");
    const cp = createCheckpointer(root);
    cp.snapshot("t1");
    cp.captureOriginal(["a.txt"]);
    writeFileSync(a, "v2");
    cp.captureOriginal(["a.txt"]); // 第二次:应该是 no-op,不覆盖已抢救的 v1
    const ref = cp.snapshot("t2");
    writeFileSync(a, "v3");
    expect(cp.restore(ref!)).toBe(true);
    expect(readFileSync(a, "utf8")).toBe("v2"); // t2 封存时重新 add 了 everTouched 里的 a → 是 v2,不是 v1
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/session/checkpoint.test.ts -t "captureOriginal"`
Expected: FAIL——`cp.captureOriginal` 不是函数(接口还没实现)。

- [ ] **Step 3: 实现 captureOriginal + everTouched + init 提交**

编辑 `src/session/checkpoint.ts`:

1. import 里加 `existsSync`(已有 `existsSync, mkdirSync, writeFileSync` 从 `node:fs` 导入,只需确认 `existsSync` 在列——当前已经在列,无需改动这一行)。

2. 在 `Checkpointer` 接口里新增方法签名(紧跟 `snapshot` 之后):

```ts
export interface Checkpointer {
  enabled: boolean;
  snapshot(label: string): string | null;
  // 写/新建文件之前调用:对"这个 session 里第一次被传入"的路径,把它当前(修改前)的内容抢救进
  // 最近一次 snapshot() 封存的提交(amend)。已抢救过的路径直接跳过。不存在的路径(即将新建的
  // 文件)只记入已抢救集合,不做 git 操作。
  captureOriginal(paths: string[]): void;
  restore(ref: string): boolean;
  list(limit?: number): { ref: string; label: string; ts: string }[];
}
```

3. `noop` 对象补上 `captureOriginal: () => {}`。

4. 在 `createCheckpointer` 函数体里,`const MAX_MS = ...` 那行之后、`return {` 之前,加:

```ts
  const everTouched = new Set<string>(); // DAO 自己碰过的路径(Edit/Write 精确路径 + captureOriginalFull 发现的路径)
```

5. 初始化流程(`if (!existsSync(gitDir)) { ... }` 块内,`writeFileSync(path.join(gitDir, "info", "exclude"), ...)` 之后)补一个空的初始提交,保证后面第一次 `captureOriginal` 调用时【总有一个提交可以 amend】:

```ts
      run(["commit", "--allow-empty", "--no-verify", "-m", "checkpoint: init"]);
```

6. `snapshot` 方法体改成:

```ts
    snapshot(label) {
      try {
        const existing = [...everTouched].filter((p) => existsSync(path.join(workspaceRoot, p)));
        if (existing.length > 0) run(["add", "--", ...existing]);
        run(["commit", "--allow-empty", "--no-verify", "-m", label]);
        return run(["rev-parse", "HEAD"]).trim();
      } catch {
        return null;
      }
    },
```

（先删掉旧的 `if (tooSlow) return null;` 分支和 `run(["add","-A"])`/`tooSlow` 判定——这些逻辑移到 Task 3 的 `captureOriginalFull` 里,`snapshot` 本身不再需要,因为它现在只对【已知的少量路径】做 `add`,不可能因为工作区里躺着无关大文件而变慢。）

7. 新增 `captureOriginal` 方法(放在 `snapshot` 之后、`restore` 之前):

```ts
    captureOriginal(paths) {
      const fresh = paths.filter((p) => !everTouched.has(p));
      if (fresh.length === 0) return;
      for (const p of fresh) everTouched.add(p);
      const existing = fresh.filter((p) => existsSync(path.join(workspaceRoot, p)));
      if (existing.length === 0) return; // 全是即将新建的文件,没有"原始内容"要抢救
      try {
        run(["add", "--", ...existing]);
        run(["commit", "--amend", "--no-edit", "--no-verify"]);
      } catch { /* 抢救失败不影响主流程,只是这份原始内容这次没被保护到 */ }
    },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/session/checkpoint.test.ts`
Expected: PASS(含之前已有的 2 个用例——它们只用 `snapshot`/`restore`/`list`,不涉及 `captureOriginal`,应该继续通过;若"不污染用户 .git"用例因为新增 init 提交而需要调整断言,按实际报错调整,不应改变其断言意图)。

- [ ] **Step 5: Commit**

```bash
git add src/session/checkpoint.ts src/session/checkpoint.test.ts
git commit -m "feat(checkpoint): captureOriginal 精确路径抢救,snapshot 不再全树 add"
```

---

### Task 2: Checkpointer——captureOriginalFull(Bash/exec 兜底)+ consumeSlowNotice

**Files:**
- Modify: `src/session/checkpoint.ts`
- Test: `src/session/checkpoint.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `everTouched`、`run()` helper、`HARD_TIMEOUT_MS`、`MAX_MS`。
- Produces: `Checkpointer.captureOriginalFull(): void` —— Bash/exec 类调用之前调用,退化成 `git add -A`(硬超时保护,不变),把 `git diff --cached --name-only` 发现的路径并入 `everTouched`(这样以后这些文件被 `snapshot()` 精确重新 add,不用再走一次全量);超过 `MAX_MS` 或抛错(含超时被杀)则把 `tooSlow` 置位——之后 `captureOriginalFull` 直接跳过不再重试(注意:只影响 `captureOriginalFull` 这一个方法,`captureOriginal`/`snapshot` 不受影响,因为它们的开销只跟"DAO 碰过多少文件"成正比,跟工作区里躺着多少无关大文件无关)。`Checkpointer.consumeSlowNotice(): boolean` —— 取走并清空"是否发生过 tooSlow"的一次性标记,供上层给用户提示一次。

- [ ] **Step 1: 写失败测试——大工作区下 captureOriginalFull 硬超时保护 + tooSlow 后续跳过**

替换掉现有(上一轮修复留下的)"createCheckpointer 硬超时"describe 块里对 `cp.snapshot(...)` 的调用,改成调用 `cp.captureOriginalFull()`(因为全量 add 的职责挪到了这个新方法上)：

```ts
  it("git add -A 卡住时 captureOriginalFull 在硬超时内返回,不会傻等子进程跑完,且 tooSlow 后续直接跳过", () => {
    writeFileSync(path.join(root, "a.txt"), "v1");
    const cp = createCheckpointer(root);
    const t0 = Date.now();
    cp.captureOriginalFull();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(4000); // 远小于假 git 的 5s sleep

    // tooSlow 已置位:第二次调用应该几乎瞬间返回(直接跳过,不再触发假 git 的 5s sleep)
    const t1 = Date.now();
    cp.captureOriginalFull();
    expect(Date.now() - t1).toBeLessThan(100);

    expect(cp.consumeSlowNotice()).toBe(true); // 触发过一次,取走后...
    expect(cp.consumeSlowNotice()).toBe(false); // ...第二次取是空的
  }, 10000);
```

（这个测试用例复用同一个 describe 块里已有的 `beforeEach`/`afterEach` 假 git 脚本设置,不用重写。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/session/checkpoint.test.ts -t "captureOriginalFull"`
Expected: FAIL——`cp.captureOriginalFull`/`cp.consumeSlowNotice` 不是函数。

- [ ] **Step 3: 实现**

`Checkpointer` 接口新增:

```ts
  captureOriginalFull(): void;
  consumeSlowNotice(): boolean;
```

`noop` 对象补:`captureOriginalFull: () => {}, consumeSlowNotice: () => false,`。

`createCheckpointer` 内部,`everTouched` 声明之后加:

```ts
  let tooSlow = false;
  let slowNoticePending = false;
```

（删除旧的 `let tooSlow = false;` 声明——Task 1 里 `snapshot()` 已经不再引用它,这里重新声明一次,连同新增的 `slowNoticePending`。）

新增方法(放在 `captureOriginal` 之后):

```ts
    captureOriginalFull() {
      if (tooSlow) return;
      try {
        const t0 = Date.now();
        run(["add", "-A"]);
        const changed = run(["diff", "--cached", "--name-only"]).trim();
        if (changed) {
          run(["commit", "--amend", "--no-edit", "--no-verify"]);
          for (const p of changed.split("\n")) if (p) everTouched.add(p);
        }
        if (Date.now() - t0 > MAX_MS) { tooSlow = true; slowNoticePending = true; }
      } catch {
        tooSlow = true;
        slowNoticePending = true;
      }
    },
    consumeSlowNotice() {
      const v = slowNoticePending;
      slowNoticePending = false;
      return v;
    },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/session/checkpoint.test.ts`
Expected: PASS(全部用例,含 Task 1 新增的)。

- [ ] **Step 5: Commit**

```bash
git add src/session/checkpoint.ts src/session/checkpoint.test.ts
git commit -m "feat(checkpoint): captureOriginalFull(Bash/exec 兜底)+ consumeSlowNotice"
```

---

### Task 3: ToolContext 暴露 checkpointTrack 钩子

**Files:**
- Modify: `src/tools/types.ts`

**Interfaces:**
- Consumes: 无(纯类型定义)。
- Produces: `ToolContext.checkpointTrack?: { captureOriginal(paths: string[]): void; captureOriginalFull(): void }` —— Task 4 的 `execute.ts` 消费,Task 5 的 `index.ts` 赋值。

- [ ] **Step 1: 加字段**

在 `src/tools/types.ts` 里 `toolAudit?: import("./tool_audit.js").ToolAuditSink;`(第 162 行)之后新增:

```ts
  // 影子 git 快照的"写前抢救"钩子(见 src/session/checkpoint.ts)。write 类工具(能拿到精确路径)
  // 调 captureOriginal([path]);exec 类(Bash,路径不可预知)调 captureOriginalFull()(退化全量
  // add -A,仍受硬超时保护)。不设置(如测试里的裸 ToolContext)则 execute.ts 里的调用是 no-op(可选链)。
  checkpointTrack?: {
    captureOriginal(paths: string[]): void;
    captureOriginalFull(): void;
  };
```

- [ ] **Step 2: 跑类型检查确认没破坏其它地方**

Run: `npx tsc --noEmit`
Expected: PASS(新增的是可选字段,不影响任何现有 `ToolContext` 字面量的类型检查)。

- [ ] **Step 3: Commit**

```bash
git add src/tools/types.ts
git commit -m "feat(tools): ToolContext 新增 checkpointTrack 可选钩子"
```

---

### Task 4: execute.ts 派发前调用 checkpointTrack

**Files:**
- Modify: `src/tools/execute.ts`
- Test: `src/tools/execute.test.ts`(已存在——`executeToolCalls(toolCalls, registry, ctx, gate): Promise<ToolMessage[]>`,已有 `reg()`/`call()`/`gateWith()` 三个 helper,复用它们,不新造一套 mock 风格)

**Interfaces:**
- Consumes: `ToolContext.checkpointTrack`(Task 3)、`toCcIdentity`(已有,`src/permissions/identity.ts`,`Edit`/`Write`/`NotebookEdit` 会返回 `{ ccTool, value: <path> }`,`Bash` 返回 `{ ccTool: "Bash", value: <command> }` 不是路径)。
- Produces: 无新增导出——修改 `dispatchOne` 内部行为(`dispatchOne` 未导出,只能通过 `executeToolCalls` 间接测试)。

- [ ] **Step 1: 写失败测试——write 工具派发前调用 captureOriginal,exec 工具派发前调用 captureOriginalFull**

在 `src/tools/execute.test.ts` 末尾(最后一个 `describe` 块之后)新增,复用文件已有的 `call()`/`gateWith()`:

```ts
describe("checkpointTrack 派发前抢救", () => {
  function regWithBash() {
    const r = reg(); // 已含 Read(capability:"read")、Write(capability:"write")
    r.register(
      defineTool({
        name: "Bash", description: "", capability: "exec", approval: "auto",
        schema: z.object({}), handler: async () => "ran",
      }),
    );
    return r;
  }

  it("write 工具(带 path 参数)派发前调用 captureOriginal([path])", async () => {
    const captureOriginal = vi.fn();
    const captureOriginalFull = vi.fn();
    const { gate } = gateWith(true); // Write 走 ask 分支,批准后才派发
    const ctxWithTrack = { ...ctx, checkpointTrack: { captureOriginal, captureOriginalFull } };
    await executeToolCalls([call("a", "Write", JSON.stringify({ path: "a.txt", content: "x" }))], reg(), ctxWithTrack, gate);
    expect(captureOriginal).toHaveBeenCalledWith(["a.txt"]);
    expect(captureOriginalFull).not.toHaveBeenCalled();
  });

  it("exec 工具(Bash)派发前调用 captureOriginalFull,不调用 captureOriginal", async () => {
    const captureOriginal = vi.fn();
    const captureOriginalFull = vi.fn();
    const { gate } = gateWith(true);
    const ctxWithTrack = { ...ctx, checkpointTrack: { captureOriginal, captureOriginalFull } };
    await executeToolCalls([call("a", "Bash", JSON.stringify({ command: "ls" }))], regWithBash(), ctxWithTrack, gate);
    expect(captureOriginalFull).toHaveBeenCalledOnce();
    expect(captureOriginal).not.toHaveBeenCalled();
  });

  it("read 工具不触发任何抢救", async () => {
    const captureOriginal = vi.fn();
    const captureOriginalFull = vi.fn();
    const { gate } = gateWith(true);
    const ctxWithTrack = { ...ctx, checkpointTrack: { captureOriginal, captureOriginalFull } };
    await executeToolCalls([call("a", "Read")], reg(), ctxWithTrack, gate);
    expect(captureOriginal).not.toHaveBeenCalled();
    expect(captureOriginalFull).not.toHaveBeenCalled();
  });
});
```

顶部 `import` 列表需要新增 `vi`(改成 `import { describe, it, expect, vi } from "vitest";`)——其余 import(`z`、`defineTool` 等)文件里已有,直接复用。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/tools/execute.test.ts`
Expected: FAIL——`captureOriginal`/`captureOriginalFull` 没被调用(逻辑还没接上)。

- [ ] **Step 3: 实现**

编辑 `src/tools/execute.ts`:

1. import 里加 `toCcIdentity`:

```ts
import { toCcIdentity } from "../permissions/identity.js";
```

2. 在 `dispatchOne` 函数体内,`const finalArgs = effectiveArgs ?? applyUpdatedInput(argsJson, h);` 之后、`const audit = ...` 之前,插入:

```ts
  // 影子 git 快照的写前抢救:write 类(Edit/Write/NotebookEdit,能拿到精确路径)只抢救那一个路径,
  // 便宜、不管工作区多大;exec 类(Bash,改哪个文件不可预知)退化成全量扫描(仍受硬超时保护,
  // 但只在真的要跑 Bash 时才付这个代价,不是每个回合无条件付)。
  if (cap === "write") {
    const p = toCcIdentity(name, finalArgs)?.value;
    if (p) ctx.checkpointTrack?.captureOriginal([p]);
    else ctx.checkpointTrack?.captureOriginalFull();
  } else if (cap === "exec") {
    ctx.checkpointTrack?.captureOriginalFull();
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/tools/execute.test.ts`
Expected: PASS。

Run: `npx vitest run src/tools`
Expected: PASS(确认没有破坏 execute.ts 原有测试)。

- [ ] **Step 5: Commit**

```bash
git add src/tools/execute.ts src/tools/execute.test.ts
git commit -m "feat(tools): 派发 write/exec 工具前接入 checkpoint 写前抢救"
```

---

### Task 5: index.ts 接线 + tooSlow 用户提示

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `ckpt`(`src/index.ts:1654`)、`ToolContext.checkpointTrack`(Task 3)、`Checkpointer.consumeSlowNotice`(Task 2)。

- [ ] **Step 1: 接线 checkpointTrack**

在 `src/index.ts:1654` `const ckpt = createCheckpointer(workspaceRoot);` 之后新增一行:

```ts
      ctx.checkpointTrack = { captureOriginal: (p) => ckpt.captureOriginal(p), captureOriginalFull: () => ckpt.captureOriginalFull() };
```

- [ ] **Step 2: tooSlow 触发时给用户可见提示**

在 `submit: async (text, { events, signal }) => { ... }`(`src/index.ts:1673` 起)里,`store.append({ t: "turn_end" });`(第 1713 行)之后加:

```ts
          if (ckpt.consumeSlowNotice()) events.notice("[检查点] 本回合有改动很大/很慢的文件,已跳过对它的自动快照保护(不影响本回合本身,只是 /rewind 可能覆盖不到这部分改动)。");
```

- [ ] **Step 3: 手动验证(无法自动化,写清楚验证步骤)**

```bash
npm run bundle:install
```

新开一个普通大小的 git 仓库目录,跑 `dao`,发一条会触发 Edit 的消息(比如"把 README 里的 xxx 改成 yyy"),确认:
1. 不再有明显的"发消息后卡几秒"的观感(以前哪怕是正常大小仓库,每回合也有一次全树 `add -A` 的隐性开销)。
2. `/rewind` 能正常回退。

再验证之前复现过的场景:在一个几十 GB、含未被 `EXCLUDES` 覆盖的大文件目录(或临时造一个:`mkdir /tmp/bigdir && dd if=/dev/zero of=/tmp/bigdir/big.bin bs=1m count=2000`,注意 `.bin` 在 `EXCLUDES` 里,换成 `dd ... of=/tmp/bigdir/big.rar` 之类不在排除列表里的后缀)里跑 `dao`,发一条只会触发 Edit(不触发 Bash)的消息,确认不再卡死——因为 `captureOriginal` 只抢救 Edit 涉及的那一个路径,不会去碰 `big.rar`。

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(index): 接线 checkpointTrack,tooSlow 触发时提示用户"
```

---

### Task 6: 全量回归 + 重新编译安装

**Files:** 无新改动,验证性任务。

- [ ] **Step 1: 全量测试**

Run: `npx vitest run`
Expected: PASS(全部套件,不只是本计划涉及的目录)。

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 3: 编译安装**

Run: `npm run bundle:install`
Expected: 输出 `已安装 → /Users/huaruoxu/.local/bin/dao`。

- [ ] **Step 4: Commit(如果前面步骤有遗留的 fixup 改动)**

```bash
git add -A
git status # 确认没有意外遗漏的文件
git commit -m "chore(checkpoint): 回归验证通过" # 仅在确实有改动时才提交
```

---

## Self-Review Notes(写完后自查,供执行者参考,非必须逐条照做)

- **Spec 覆盖**:精确路径抢救(Task 1)、Bash 兜底 + tooSlow 只影响兜底路径(Task 2)、钩子类型(Task 3)、执行链路接入(Task 4)、真实接线 + 用户可见提示(Task 5)、回归(Task 6)——覆盖了上一轮讨论里"用 DAO 自己的工具调用记录做精确路径,而不是全树 diff"的核心诉求。
- **已知限制,不在本计划范围内**:`captureOriginalFull` 本身在真的跑 Bash/exec 时仍是 O(工作区大小)、仍依赖硬超时兜底(不是"消灭"这个代价,是"不再无条件每回合都付")。如果未来还想优化 Bash 场景(比如按 cwd 限定 pathspec、或者用 `git status --porcelain` 配合已知目录白名单),需要另开一个计划,不在这次范围内。
- **类型一致性**:`captureOriginal(paths: string[]): void` / `captureOriginalFull(): void` / `consumeSlowNotice(): boolean` 三个方法名和签名在 Task 1/2(`Checkpointer` 接口定义处)、Task 3(`ToolContext.checkpointTrack` 类型)、Task 4(`execute.ts` 调用处 + 测试里的 `vi.fn()` 断言)、Task 5(`index.ts` 接线)四处逐一核对过,命名和参数形状一致。
