// src/agent/agent_lifecycle.test.ts
import { describe, it, expect, vi } from "vitest";
import { runAsyncAgentLifecycle } from "./agent_lifecycle.js";
import type { ChatMessage } from "../client/types.js";

async function* fakeStream(messages: ChatMessage[]): AsyncGenerator<ChatMessage, void> {
  for (const m of messages) yield m;
}

async function* throwingStream(before: ChatMessage[], err: Error): AsyncGenerator<ChatMessage, void> {
  for (const m of before) yield m;
  throw err;
}

function mkTaskManager() {
  return {
    appendMessage: vi.fn((_taskId: string, _m: ChatMessage) => true),
    updateSummary: vi.fn((_taskId: string, _s: string) => true),
    update: vi.fn((_taskId: string, _patch: { status?: "completed" | "failed" | "canceled"; result?: string }) => true),
  };
}

describe("runAsyncAgentLifecycle", () => {
  it("逐条把 stream 产出的消息 appendMessage 到任务", async () => {
    const taskManager = mkTaskManager();
    const messages: ChatMessage[] = [
      { role: "assistant", content: "第一步" },
      { role: "assistant", content: "完成" },
    ];
    await runAsyncAgentLifecycle({
      taskId: "task-1", agentId: "agent-1", prompt: "do x", model: "flash",
      makeStream: () => fakeStream(messages),
      taskManager,
    });
    expect(taskManager.appendMessage).toHaveBeenCalledTimes(2);
    expect(taskManager.appendMessage).toHaveBeenNthCalledWith(1, "task-1", messages[0]);
    expect(taskManager.appendMessage).toHaveBeenNthCalledWith(2, "task-1", messages[1]);
  });

  it("正常结束后用最后一条 assistant 文本结算 completed", async () => {
    const taskManager = mkTaskManager();
    const messages: ChatMessage[] = [
      { role: "assistant", content: "中间" },
      { role: "assistant", content: "最终结论" },
    ];
    await runAsyncAgentLifecycle({
      taskId: "task-1", agentId: "agent-1", prompt: "do x", model: "flash",
      makeStream: () => fakeStream(messages),
      taskManager,
    });
    expect(taskManager.update).toHaveBeenCalledWith("task-1", { status: "completed", result: "最终结论" });
  });

  it("stream 抛错时结算 failed,并带上已产出的部分结果", async () => {
    const taskManager = mkTaskManager();
    const messages: ChatMessage[] = [{ role: "assistant", content: "跑到一半" }];
    await runAsyncAgentLifecycle({
      taskId: "task-1", agentId: "agent-1", prompt: "do x", model: "flash",
      makeStream: () => throwingStream(messages, new Error("网络中断")),
      taskManager,
    });
    expect(taskManager.update).toHaveBeenCalledTimes(1);
    const [, patch] = taskManager.update.mock.calls[0]!;
    expect(patch.status).toBe("failed");
    expect(patch.result).toContain("网络中断");
    expect(patch.result).toContain("跑到一半");
  });

  it("makeStream 收到缓存安全参数回调时启动摘要,stream 结束后停止", async () => {
    const taskManager = mkTaskManager();
    const stopFn = vi.fn();
    const startSummarization = vi.fn(() => ({ stop: stopFn }));
    const messages: ChatMessage[] = [{ role: "assistant", content: "done" }];

    await runAsyncAgentLifecycle({
      taskId: "task-1", agentId: "agent-1", prompt: "do x", model: "flash",
      makeStream: (onCacheSafeParams) => {
        onCacheSafeParams({ systemPrompt: "sp", forkContextMessages: [] });
        return fakeStream(messages);
      },
      taskManager,
      startSummarization,
    });

    expect(startSummarization).toHaveBeenCalledWith(
      "task-1", "agent-1",
      { systemPrompt: "sp", messages: [], model: "flash" },
      expect.any(Function),
    );
    expect(stopFn).toHaveBeenCalledTimes(1);
  });
});
