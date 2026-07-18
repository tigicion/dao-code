// src/agent/resume_agent.test.ts
import { describe, it, expect, vi } from "vitest";
import {
  recordSidechainMessage, writeAgentMetadata, getAgentTranscript, readAgentMetadata,
  filterIncompleteToolCalls, resumeAgentBackground,
} from "./resume_agent.js";
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

describe("resumeAgentBackground", () => {
  const tmpDir = `/tmp/dao-test-resume-${Date.now()}`;

  function mkTaskManager() {
    return {
      appendMessage: vi.fn(() => true),
      updateSummary: vi.fn(() => true),
      update: vi.fn(() => true),
    };
  }

  it("找不到转录时抛错", async () => {
    await expect(resumeAgentBackground({
      agentId: "nonexistent",
      prompt: "继续",
      subagentsDir: tmpDir,
      agentDefs: [],
      runAgent: () => (async function* () {})(),
      registerAsyncAgent: (o) => ({ agentId: o.agentId, abortController: new AbortController() }),
      taskManager: mkTaskManager(),
    })).rejects.toThrow("未找到子代理转录");
  });

  it("一次性 agent(explore/plan)不支持恢复", async () => {
    const agentId = "oneshot-agent";
    await recordSidechainMessage(tmpDir, agentId, { role: "user", content: "hi" });
    await writeAgentMetadata(tmpDir, agentId, { agentType: "explore" });
    await expect(resumeAgentBackground({
      agentId,
      prompt: "继续",
      subagentsDir: tmpDir,
      agentDefs: [],
      runAgent: () => (async function* () {})(),
      registerAsyncAgent: (o) => ({ agentId: o.agentId, abortController: new AbortController() }),
      taskManager: mkTaskManager(),
    })).rejects.toThrow("一次性 agent");
  });

  it("把 meta.worktreePath 和注册好的 abortController 透传进 runAgent,并驱动完整生命周期", async () => {
    const agentId = "resumable-agent";
    await recordSidechainMessage(tmpDir, agentId, { role: "user", content: "接着跑" });
    await writeAgentMetadata(tmpDir, agentId, { agentType: "general-purpose", worktreePath: "/tmp/wt-1", model: "deepseek-v4-pro" });

    const taskManager = mkTaskManager();
    let receivedParams: any;
    const runAgent = vi.fn((params: any) => {
      receivedParams = params;
      return (async function* () {
        yield { role: "assistant", content: "恢复后完成" } as ChatMessage;
      })();
    });
    let capturedAbortController: AbortController | undefined;
    const registerAsyncAgent = vi.fn((o: { agentId: string; description: string }) => {
      capturedAbortController = new AbortController();
      return { agentId: o.agentId, abortController: capturedAbortController };
    });

    const result = await resumeAgentBackground({
      agentId, prompt: "继续", subagentsDir: tmpDir, agentDefs: [], runAgent, registerAsyncAgent, taskManager,
    });

    expect(result.agentId).toBe(agentId);
    expect(receivedParams.worktreePath).toBe("/tmp/wt-1");
    expect(receivedParams.override.abortController).toBe(capturedAbortController);
    expect(receivedParams.isAsync).toBe(true);

    // 生命周期是 fire-and-forget 启动的,等它跑完再断言结算结果
    await new Promise((r) => setTimeout(r, 20));
    expect(taskManager.appendMessage).toHaveBeenCalledWith(agentId, { role: "assistant", content: "恢复后完成" });
    expect(taskManager.update).toHaveBeenCalledWith(agentId, { status: "completed", result: "恢复后完成" });
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
