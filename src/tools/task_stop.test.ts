import { describe, it, expect } from "vitest";
import { taskStopTool } from "./task_stop.js";
import { createTaskManager } from "../agent/tasks.js";

describe("task_stop", () => {
  it("停止手动建的任务 → canceled", async () => {
    const taskManager = createTaskManager();
    const id = taskManager.create("任务A");
    const out = await taskStopTool.handler({ id }, { workspaceRoot: "/w", taskManager });
    expect(out).toContain("已停止");
    expect(taskManager.get(id)?.status).toBe("canceled");
  });

  it("停止真实后台子代理 → 真正中止(不再入队完成通知)", async () => {
    const taskManager = createTaskManager();
    const id = taskManager.launch("长任务", (signal) => new Promise((_res, rej) => {
      signal.addEventListener("abort", () => rej(new Error("aborted")));
    }));
    const out = await taskStopTool.handler({ id }, { workspaceRoot: "/w", taskManager });
    expect(out).toContain("已停止");
    expect(taskManager.get(id)?.status).toBe("canceled");
  });

  it("已结束的任务再停 → 未生效", async () => {
    const taskManager = createTaskManager();
    const id = taskManager.create("任务A");
    taskManager.update(id, { status: "completed" });
    const out = await taskStopTool.handler({ id }, { workspaceRoot: "/w", taskManager });
    expect(out).toContain("未生效");
  });
});
