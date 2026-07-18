// src/agent/agent_summary.test.ts
import { describe, it, expect, vi } from "vitest";
import { startAgentSummarization } from "./agent_summary.js";

describe("startAgentSummarization", () => {
  it("返回带 stop() 的对象", () => {
    const { stop } = startAgentSummarization("task-1", "agent-1", { systemPrompt: "", messages: [], model: "flash" }, () => {});
    expect(typeof stop).toBe("function");
    stop();
  });
  it("stop() 后不再触发摘要", async () => {
    const cb = vi.fn();
    const { stop } = startAgentSummarization("task-1", "agent-1", { systemPrompt: "", messages: [], model: "flash" }, cb);
    stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(cb).not.toHaveBeenCalled();
  });
});
