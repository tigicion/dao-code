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
