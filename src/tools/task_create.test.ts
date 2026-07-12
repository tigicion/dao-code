import { describe, it, expect } from "vitest";
import { taskCreateTool } from "./task_create.js";
import { createTaskManager } from "../agent/tasks.js";

describe("task_create", () => {
  it("建一个任务,返回 id 并可查", async () => {
    const taskManager = createTaskManager();
    const out = await taskCreateTool.handler({ description: "手动跟踪的工作" }, { workspaceRoot: "/w", taskManager });
    expect(out).toMatch(/已创建任务 task-\d+:手动跟踪的工作/);
    expect(taskManager.running()).toHaveLength(1);
  });

  it("环境不支持任务追踪 → 提示", async () => {
    const out = await taskCreateTool.handler({ description: "x" }, { workspaceRoot: "/w" });
    expect(out).toContain("不支持任务追踪");
  });
});
