// src/agent/agent_handoff.test.ts
import { describe, it, expect } from "vitest";
import { classifyHandoffIfNeeded } from "./agent_handoff.js";
import type { ChatMessage } from "../client/types.js";

describe("classifyHandoffIfNeeded", () => {
  it("非 auto 模式返回 null", async () => {
    expect(await classifyHandoffIfNeeded({ agentMessages: [], permissionMode: "default" as any, abortSignal: new AbortController().signal, subagentType: "t", totalToolUseCount: 0 })).toBeNull();
  });
  it("auto 模式 + 空消息返回 null", async () => {
    expect(await classifyHandoffIfNeeded({ agentMessages: [], permissionMode: "auto" as any, abortSignal: new AbortController().signal, subagentType: "t", totalToolUseCount: 0 })).toBeNull();
  });
  it("分类器不可用 -> 警告", async () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "x" }, { role: "assistant", content: "y", tool_calls: [] }];
    const r = await classifyHandoffIfNeeded({ agentMessages: msgs, permissionMode: "auto" as any, abortSignal: new AbortController().signal, subagentType: "t", totalToolUseCount: 1, classifyFn: async () => ({ unavailable: true }) });
    expect(r).toContain("分类器不可用");
  });
  it("blocked -> 安全警告", async () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "x" }, { role: "assistant", content: "y", tool_calls: [] }];
    const r = await classifyHandoffIfNeeded({ agentMessages: msgs, permissionMode: "auto" as any, abortSignal: new AbortController().signal, subagentType: "t", totalToolUseCount: 1, classifyFn: async () => ({ shouldBlock: true, reason: "删文件" }) });
    expect(r).toContain("安全警告");
    expect(r).toContain("删文件");
  });
  it("allowed -> null", async () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "x" }, { role: "assistant", content: "y", tool_calls: [] }];
    expect(await classifyHandoffIfNeeded({ agentMessages: msgs, permissionMode: "auto" as any, abortSignal: new AbortController().signal, subagentType: "t", totalToolUseCount: 1, classifyFn: async () => ({ shouldBlock: false }) })).toBeNull();
  });
});
