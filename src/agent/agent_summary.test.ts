// src/agent/agent_summary.test.ts
import { describe, it, expect, vi } from "vitest";
import { startAgentSummarization } from "./agent_summary.js";
import type { ChatMessage } from "../client/types.js";

const msgsWithTool: ChatMessage[] = [
  {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: "{}" } }],
  },
];

describe("startAgentSummarization", () => {
  it("返回带 stop() 的对象", () => {
    const { stop } = startAgentSummarization("task-1", "agent-1", { systemPrompt: "", messages: [], model: "flash" }, () => {});
    expect(typeof stop).toBe("function");
    stop();
  });

  it("定期把摘要通过 updateSummary(taskId, summary) 回调写出", async () => {
    const updateSummary = vi.fn();
    const { stop } = startAgentSummarization(
      "task-1", "agent-1",
      { systemPrompt: "", messages: msgsWithTool, model: "flash" },
      updateSummary,
      { intervalMs: 10 },
    );
    await new Promise((r) => setTimeout(r, 30));
    stop();
    expect(updateSummary).toHaveBeenCalledWith("task-1", expect.stringContaining("read_file"));
  });

  it("stop() 后不再触发摘要", async () => {
    const updateSummary = vi.fn();
    const { stop } = startAgentSummarization(
      "task-1", "agent-1",
      { systemPrompt: "", messages: msgsWithTool, model: "flash" },
      updateSummary,
      { intervalMs: 10 },
    );
    stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(updateSummary).not.toHaveBeenCalled();
  });
});
