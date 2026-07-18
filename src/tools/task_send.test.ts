import { describe, it, expect } from "vitest";
import { taskSendTool } from "./task_send.js";

describe("task_send", () => {
  it("给运行中任务发消息", async () => {
    let sent: [string, string] | null = null;
    const out = await taskSendTool.handler(
      { id: "task-1", message: "纠偏" },
      { workspaceRoot: "/w", sendToTask: (id, m) => { sent = [id, m]; return true; } },
    );
    expect(out).toContain("已发送给 task-1");
    expect(sent).toEqual(["task-1", "纠偏"]);
  });

  it("任务不存在 → 提示无法发送", async () => {
    const out = await taskSendTool.handler(
      { id: "task-9", message: "x" },
      { workspaceRoot: "/w", sendToTask: () => false },
    );
    expect(out).toContain("无法发送");
  });

  it("任务已结束(有 taskManager 记录)→ 自动 resume 而不是直接报失败", async () => {
    let resumed: [string, string] | null = null;
    const out = await taskSendTool.handler(
      { id: "task-2", message: "接着查一下 lib 目录" },
      {
        workspaceRoot: "/w",
        sendToTask: () => false, // 已结束,底层 send 必然失败
        taskManager: { get: (id: string) => (id === "task-2" ? { id, status: "completed" } : undefined) } as any,
        resumeAgent: async (id, prompt) => { resumed = [id, prompt]; return "ok"; },
      },
    );
    expect(resumed).toEqual(["task-2", "接着查一下 lib 目录"]);
    expect(out).toContain("已恢复");
  });

  it("任务已结束但 resume 失败(如一次性 agent)→ 提示无法恢复的具体原因", async () => {
    const out = await taskSendTool.handler(
      { id: "task-3", message: "继续" },
      {
        workspaceRoot: "/w",
        sendToTask: () => false,
        taskManager: { get: (id: string) => (id === "task-3" ? { id, status: "completed" } : undefined) } as any,
        resumeAgent: async () => { throw new Error("explore 是一次性 agent,不支持恢复。"); },
      },
    );
    expect(out).toContain("无法恢复");
    expect(out).toContain("一次性 agent");
  });
});
