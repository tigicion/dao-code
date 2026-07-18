import { describe, it, expect } from "vitest";
import { taskListTool } from "./task_list.js";
import { createTaskManager } from "../agent/tasks.js";

describe("TaskList", () => {
  it("默认只列运行中的", async () => {
    const taskManager = createTaskManager();
    const a = taskManager.create("任务A");
    taskManager.create("任务B");
    taskManager.update(a, { status: "completed" });
    const out = await taskListTool.handler({}, { workspaceRoot: "/w", taskManager });
    expect(out).toContain("任务B");
    expect(out).not.toContain("任务A");
  });

  it("include_finished=true 连已结束的也列出", async () => {
    const taskManager = createTaskManager();
    const a = taskManager.create("任务A");
    taskManager.update(a, { status: "completed" });
    const out = await taskListTool.handler({ include_finished: true }, { workspaceRoot: "/w", taskManager });
    expect(out).toContain("任务A");
  });

  it("空列表 → 提示暂无", async () => {
    const taskManager = createTaskManager();
    const out = await taskListTool.handler({}, { workspaceRoot: "/w", taskManager });
    expect(out).toContain("暂无运行中的任务");
  });
});
