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
      // 模拟子代理中途用 MessageParent → runBackgroundAgent 绑定的 messageParent = emitFromTask(taskId, .)
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

describe("create/update:手动任务(不背靠 promise)", () => {
  it("create 建的任务默认 running,可查", () => {
    const tm = createTaskManager();
    const id = tm.create("手动跟踪的工作");
    expect(id).toMatch(/^task-/);
    expect(tm.get(id)?.status).toBe("running");
    expect(tm.running()).toHaveLength(1);
  });

  it("update 改 description 不影响状态", () => {
    const tm = createTaskManager();
    const id = tm.create("旧描述");
    expect(tm.update(id, { description: "新描述" })).toBe(true);
    expect(tm.get(id)?.description).toBe("新描述");
    expect(tm.get(id)?.status).toBe("running");
  });

  it("update 改 status→completed:入队通知,和 launch/adopt 一致", () => {
    const tm = createTaskManager();
    const id = tm.create("手动任务");
    expect(tm.update(id, { status: "completed", result: "手动填的结论" })).toBe(true);
    expect(tm.get(id)?.status).toBe("completed");
    const notes = tm.drainNotifications();
    expect(notes[0]).toContain("手动填的结论");
    expect(notes[0]).toContain("completed");
  });

  it("已结束的任务不可再 update status(防重复结算)", () => {
    const tm = createTaskManager();
    const id = tm.create("t");
    tm.update(id, { status: "completed" });
    expect(tm.update(id, { status: "failed" })).toBe(false);
    expect(tm.get(id)?.status).toBe("completed"); // 状态不变
  });

  it("update 不存在的任务 → false", () => {
    const tm = createTaskManager();
    expect(tm.update("task-不存在", { status: "completed" })).toBe(false);
  });

  it("cancel 对 create 建的任务也生效(无 controller,仍能标记取消)", () => {
    const tm = createTaskManager();
    const id = tm.create("t");
    expect(tm.cancel(id)).toBe(true);
    expect(tm.get(id)?.status).toBe("canceled");
  });

  it("all() 含已结束任务,running() 不含", () => {
    const tm = createTaskManager();
    const a = tm.create("a");
    tm.create("b");
    tm.update(a, { status: "completed" });
    expect(tm.all()).toHaveLength(2);
    expect(tm.running()).toHaveLength(1);
  });
});

describe("adopt 的手动结束防御(补齐与 launch 一致的竞态保护)", () => {
  it("adopt 任务被手动 update 为 failed 后,底层 promise 才 resolve → 不覆盖、不重复通知", async () => {
    const tm = createTaskManager();
    let resolve!: (s: string) => void;
    const id = tm.adopt("接管的", new Promise<string>((r) => { resolve = r; }));
    expect(tm.update(id, { status: "failed", result: "手动判定失败" })).toBe(true);
    resolve("真实结果(应被忽略)"); // 模拟底层 promise 事后才真正结束
    await tick();
    expect(tm.get(id)?.status).toBe("failed"); // 未被真实结果覆盖
    expect(tm.get(id)?.error).toBe("手动判定失败");
    const notes = tm.drainNotifications();
    expect(notes).toHaveLength(1); // 只有手动那次的通知,promise 结算没有重复入队
  });
});

describe("registerAgentForeground:taskId 与 agentId 统一,cancel 真实生效", () => {
  it("taskId 恒等于传入的 agentId(此前另起 task-N 计数器,和子代理的 drainPending 用的 agentId 对不上号)", () => {
    const tm = createTaskManager();
    const { taskId } = tm.registerAgentForeground({ agentId: "agent-xyz123", description: "跑一个" });
    expect(taskId).toBe("agent-xyz123");
  });

  it("自建并返回 abortController(与 registerAsyncAgent 同一套写法,调用方不用自己 new 再传进来)", () => {
    const tm = createTaskManager();
    const { abortController } = tm.registerAgentForeground({ agentId: "agent-xyz123", description: "跑一个" });
    expect(abortController).toBeInstanceOf(AbortController);
    expect(abortController.signal.aborted).toBe(false);
  });

  it("cancel() 真的 abort 返回的 controller(此前前台任务没注册 controller,cancel 只翻状态位不中止真实工作)", () => {
    const tm = createTaskManager();
    const { taskId, abortController } = tm.registerAgentForeground({ agentId: "agent-xyz123", description: "跑一个" });
    expect(tm.cancel(taskId)).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
    expect(tm.get(taskId)?.status).toBe("canceled");
  });

  it("send() 发的消息用同一个 id 就能被 drainPending 读到(TaskSend 的实际投递路径)", () => {
    const tm = createTaskManager();
    const { taskId } = tm.registerAgentForeground({ agentId: "agent-xyz123", description: "跑一个" });
    expect(tm.send(taskId, "追加指令")).toBe(true);
    expect(tm.drainPending("agent-xyz123")).toEqual(["追加指令"]); // 用 agentId 读,而非另一个 task-N
  });
});

describe("settle():前台任务正常/异常收尾,不重复入队通知", () => {
  it("settle() 默认结算为 completed,不入队 <task-notification>(结果已经作为工具返回值同步交给父代理)", () => {
    const tm = createTaskManager();
    const { taskId } = tm.registerAgentForeground({ agentId: "agent-abc", description: "跑一个" });
    expect(tm.settle(taskId)).toBe(true);
    expect(tm.get(taskId)?.status).toBe("completed");
    expect(tm.hasPending()).toBe(false); // 没有入队通知,不会在下一回合边界重复投递
  });

  it("settle(id,'failed') 结算为 failed", () => {
    const tm = createTaskManager();
    const { taskId } = tm.registerAgentForeground({ agentId: "agent-abc", description: "跑一个" });
    expect(tm.settle(taskId, "failed")).toBe(true);
    expect(tm.get(taskId)?.status).toBe("failed");
  });

  it("已经结算过的任务再 settle()/cancel() 都不再生效(防止跑完的前台任务被 cancelAll()/TaskStop 误伤)", () => {
    const tm = createTaskManager();
    const { taskId, abortController } = tm.registerAgentForeground({ agentId: "agent-abc", description: "跑一个" });
    tm.settle(taskId);
    expect(tm.cancel(taskId)).toBe(false); // 已结束,cancel 拒绝生效
    expect(abortController.signal.aborted).toBe(false); // 没有被误 abort
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
