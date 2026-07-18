import { describe, it, expect } from "vitest";
import { taskUpdateTool } from "./task_update.js";
import { createTaskManager } from "../agent/tasks.js";

describe("TaskUpdate", () => {
  it("标记完成并给结果", async () => {
    const taskManager = createTaskManager();
    const id = taskManager.create("任务A");
    const out = await taskUpdateTool.handler({ id, status: "completed", result: "做完了" }, { workspaceRoot: "/w", taskManager });
    expect(out).toContain("已更新");
    expect(taskManager.get(id)?.status).toBe("completed");
    expect(taskManager.get(id)?.result).toBe("做完了");
  });

  it("已结束的任务不能再改状态", async () => {
    const taskManager = createTaskManager();
    const id = taskManager.create("任务A");
    taskManager.update(id, { status: "completed" });
    const out = await taskUpdateTool.handler({ id, status: "failed" }, { workspaceRoot: "/w", taskManager });
    expect(out).toContain("已结束");
    expect(taskManager.get(id)?.status).toBe("completed");
  });

  it("不存在的 id → 提示未找到", async () => {
    const taskManager = createTaskManager();
    const out = await taskUpdateTool.handler({ id: "task-999", status: "completed" }, { workspaceRoot: "/w", taskManager });
    expect(out).toContain("未找到任务");
  });
});
