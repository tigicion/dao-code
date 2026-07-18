// src/agent/resume_agent.test.ts
import { describe, it, expect } from "vitest";
import { recordSidechainMessage, writeAgentMetadata, getAgentTranscript, readAgentMetadata, filterIncompleteToolCalls } from "./resume_agent.js";
import type { ChatMessage } from "../client/types.js";

describe("转录持久化", () => {
  const tmpDir = `/tmp/dao-test-${Date.now()}`;
  const agentId = "test-agent-1";

  it("recordSidechainMessage 追加消息到 jsonl", async () => {
    await recordSidechainMessage(tmpDir, agentId, { role: "user", content: "hello" } as ChatMessage);
    await recordSidechainMessage(tmpDir, agentId, { role: "assistant", content: "hi" } as ChatMessage);
    const t = await getAgentTranscript(tmpDir, agentId);
    expect(t).not.toBeNull();
    expect(t!.messages.length).toBe(2);
  });

  it("writeAgentMetadata + readAgentMetadata", async () => {
    await writeAgentMetadata(tmpDir, agentId, { agentType: "explore", description: "test" });
    const meta = await readAgentMetadata(tmpDir, agentId);
    expect(meta!.agentType).toBe("explore");
  });

  it("getAgentTranscript 不存在返回 null", async () => {
    expect(await getAgentTranscript(tmpDir, "nonexistent")).toBeNull();
  });
});

describe("filterIncompleteToolCalls", () => {
  it("过滤未配对的 tool_use", () => {
    const msgs: ChatMessage[] = [
      { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "assistant", content: "", tool_calls: [{ id: "2", type: "function", function: { name: "grep_files", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "1", content: "result" },
    ];
    const filtered = filterIncompleteToolCalls(msgs);
    // id=2 的 tool_call 没有对应 tool_result -> 那条 assistant 被过滤
    expect(filtered.length).toBe(2);
  });
});
