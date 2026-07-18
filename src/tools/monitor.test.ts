import { describe, it, expect } from "vitest";
import { monitorTool } from "./monitor.js";
import { createTaskManager } from "../agent/tasks.js";
import type { ToolContext } from "./types.js";

// 轮询等到条件成立,而不是固定 sleep——底层是真实子进程+定时器,时序不保证,轮询等待才不 flaky。
async function waitUntil(pred: () => boolean, timeoutMs = 5000, stepMs = 30): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil 超时");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function makeCtx(taskManager: ReturnType<typeof createTaskManager>): ToolContext {
  return { workspaceRoot: process.cwd(), taskManager };
}

describe("monitor", () => {
  it("command 模式:stdout 按行推送为通知,进程退出后任务 completed", async () => {
    const taskManager = createTaskManager();
    const ctx = makeCtx(taskManager);
    const out = await monitorTool.handler(
      { command: "printf 'line1\\nline2\\n'", description: "测试输出", persistent: false, timeout_ms: 5000 },
      ctx,
    );
    const idMatch = out.match(/task id=(\S+)\)/);
    expect(idMatch).toBeTruthy();
    const taskId = idMatch![1];

    await waitUntil(() => taskManager.get(taskId!)?.status === "completed");
    const notifications = taskManager.drainNotifications();
    const joined = notifications.join("\n");
    expect(joined).toContain("line1");
    expect(joined).toContain("line2");
    expect(joined).toContain("task-notification"); // 进程退出触发的最终结算通知
  });

  it("task_stop(cancel)取消后终止底层进程,任务转为 canceled", async () => {
    const taskManager = createTaskManager();
    const ctx = makeCtx(taskManager);
    const out = await monitorTool.handler(
      { command: "sleep 30", description: "长跑命令", persistent: true },
      ctx,
    );
    const idMatch = out.match(/task id=(\S+)\)/);
    const taskId = idMatch![1]!;
    expect(taskManager.get(taskId)?.status).toBe("running");

    taskManager.cancel(taskId);
    await waitUntil(() => taskManager.get(taskId)?.status === "canceled");
  });

  it("危险命令走 checkPermissions 强制确认(ask)", () => {
    const result = monitorTool.checkPermissions!(JSON.stringify({ command: "rm -rf /", description: "危险" }));
    expect(result).toBe("ask");
  });

  it("普通命令 checkPermissions 不干预", () => {
    const result = monitorTool.checkPermissions!(JSON.stringify({ command: "tail -f app.log", description: "看日志" }));
    expect(result).toBeNull();
  });
});
