import { describe, it, expect } from "vitest";
import { taskOutputTool } from "./task_output.js";
import { createTaskManager } from "../agent/tasks.js";

describe("task_output", () => {
  it("增量返回自上次读取以来子代理任务新产生的消息", async () => {
    const taskManager = createTaskManager();
    const { agentId } = taskManager.registerAsyncAgent({ agentId: "agent-1", description: "跑测试" });
    taskManager.appendMessage(agentId, { role: "assistant", content: "开始探索代码库" });
    taskManager.appendMessage(agentId, {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "grep_files", arguments: '{"pattern":"foo"}' } }],
    });

    const first = await taskOutputTool.handler({ id: agentId }, { workspaceRoot: "/w", taskManager });
    expect(first).toContain("开始探索代码库");
    expect(first).toContain("grep_files");

    // 再调一次:没有新消息之前,不应重复看到上面这两条
    const second = await taskOutputTool.handler({ id: agentId }, { workspaceRoot: "/w", taskManager });
    expect(second).not.toContain("开始探索代码库");

    taskManager.appendMessage(agentId, { role: "tool", tool_call_id: "c1", content: "match: foo.ts:12" });
    const third = await taskOutputTool.handler({ id: agentId }, { workspaceRoot: "/w", taskManager });
    expect(third).toContain("foo.ts:12");
    expect(third).not.toContain("grep_files"); // 上一条工具调用已经在 first 里读过了
  });

  it("不存在的 id → 提示未找到", async () => {
    const taskManager = createTaskManager();
    const out = await taskOutputTool.handler({ id: "task-999" }, { workspaceRoot: "/w", taskManager });
    expect(out).toContain("未找到任务");
  });

  it("task_create 建的手动任务没有中间消息 → 提示改用 task_get", async () => {
    const taskManager = createTaskManager();
    const id = taskManager.create("手动任务");
    const out = await taskOutputTool.handler({ id }, { workspaceRoot: "/w", taskManager });
    expect(out).toContain("task_get");
  });

  it("当前环境不支持任务追踪时给出明确提示", async () => {
    const out = await taskOutputTool.handler({ id: "task-1" }, { workspaceRoot: "/w" });
    expect(out).toContain("不支持");
  });
});
