import { describe, it, expect } from "vitest";
import { createTaskManager } from "./tasks.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("TaskManager", () => {
  it("后台启动→完成→入队通知(含结果)", async () => {
    const tm = createTaskManager();
    const id = tm.launch("调查 X", async () => "调查结论");
    expect(id).toMatch(/^task-/);
    expect(tm.running()).toHaveLength(1);
    await tick();
    expect(tm.running()).toHaveLength(0);
    expect(tm.hasPending()).toBe(true);
    const notes = tm.drainNotifications();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("调查结论");
    expect(notes[0]).toContain("completed");
    expect(notes[0]).toContain(id);
    expect(tm.hasPending()).toBe(false); // drain 后清空
  });

  it("失败→入队 failed 通知", async () => {
    const tm = createTaskManager();
    tm.launch("会炸的", async () => { throw new Error("炸了"); });
    await tick();
    const notes = tm.drainNotifications();
    expect(notes[0]).toContain("failed");
    expect(notes[0]).toContain("炸了");
  });

  it("cancel 中止运行中的任务,不再入队完成通知", async () => {
    const tm = createTaskManager();
    const id = tm.launch("长任务", (signal) => new Promise((_res, rej) => {
      signal.addEventListener("abort", () => rej(new Error("aborted")));
    }));
    expect(tm.cancel(id)).toBe(true);
    expect(tm.get(id)?.status).toBe("canceled");
    await tick();
    expect(tm.hasPending()).toBe(false); // 取消的不入完成/失败通知
  });

  it("adopt 接管已运行 promise → 完成入队通知", async () => {
    const tm = createTaskManager();
    let resolve!: (s: string) => void;
    tm.adopt("接管的任务", new Promise<string>((r) => { resolve = r; }));
    expect(tm.running()).toHaveLength(1);
    resolve("后台结果X");
    await tick();
    const notes = tm.drainNotifications();
    expect(notes[0]).toContain("后台结果X");
  });

  it("send/drainPending:给运行中任务追加消息,任务在回合边界消费", async () => {
    const tm = createTaskManager();
    let drained: string[] = [];
    const id = tm.launch("t", async (_signal, taskId) => {
      await tick();
      drained = tm.drainPending(taskId);
      return "done";
    });
    expect(tm.send(id, "追加指令A")).toBe(true);
    await tick();
    await tick();
    expect(drained).toContain("追加指令A");
    expect(tm.send("task-不存在", "x")).toBe(false);
  });

  it("onChange 在启动与完成时触发", async () => {
    const tm = createTaskManager();
    let changes = 0;
    tm.onChange(() => changes++);
    tm.launch("t", async () => "r");
    expect(changes).toBe(1); // 启动
    await tick();
    expect(changes).toBe(2); // 完成
  });
});

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

describe("通知 XML 转义(防破坏父代理解析)", () => {
  it("mid-run 消息与 description 里的 < > & 及字面 </message> 被转义", async () => {
    const tm = createTaskManager();
    let release!: (v: string) => void;
    const id = tm.launch("调查 <x> & </desc>", () => new Promise<string>((res) => { release = res; }));
    tm.emitFromTask(id, "发现 a<b && c </message> 注入");
    const out = tm.drainNotifications().join("\n");
    expect(out).not.toContain("</message> 注入"); // 字面闭合标签不得原样泄漏
    expect(out).toContain("&lt;b &amp;&amp; c &lt;/message&gt;");
    expect(out).toContain("调查 &lt;x&gt; &amp; &lt;/desc&gt;"); // description 也转义
    release("done");
  });
});
