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
});
