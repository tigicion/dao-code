import { describe, it, expect } from "vitest";
import { taskGetTool } from "./task_get.js";
import { createTaskManager } from "../agent/tasks.js";

describe("task_get", () => {
  it("查已完成任务的详情,含结果", async () => {
    const taskManager = createTaskManager();
    const id = taskManager.create("任务A");
    taskManager.update(id, { status: "completed", result: "结论X" });
    const out = await taskGetTool.handler({ id }, { workspaceRoot: "/w", taskManager });
    expect(out).toContain("状态: completed");
    expect(out).toContain("结论X");
    expect(out).toContain("结束:");
  });

  it("不存在的 id → 提示未找到", async () => {
    const taskManager = createTaskManager();
    const out = await taskGetTool.handler({ id: "task-999" }, { workspaceRoot: "/w", taskManager });
    expect(out).toContain("未找到任务");
  });
});
