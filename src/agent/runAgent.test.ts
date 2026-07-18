import { describe, it, expect } from "vitest";
import { getAgentModel, filterIncompleteToolCalls } from "./runAgent.js";
import type { ChatMessage, AssistantMessage, ToolMessage } from "../client/types.js";

describe("getAgentModel", () => {
  it("agent 定义无 model -> inherit(返回父模型)", () => {
    expect(getAgentModel(undefined, "deepseek-v4-pro", undefined)).toBe("deepseek-v4-pro");
  });

  it("agent 定义 model=inherit -> 返回父模型", () => {
    expect(getAgentModel("inherit", "deepseek-v4-pro", undefined)).toBe("deepseek-v4-pro");
  });

  it("agent 定义 model=flash -> 返回 flash", () => {
    expect(getAgentModel("deepseek-v4-flash", "deepseek-v4-pro", undefined)).toBe("deepseek-v4-flash");
  });

  it("调用级 model 覆盖 > agent 定义 > inherit", () => {
    expect(getAgentModel("deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-pro-turbo")).toBe("deepseek-v4-pro-turbo");
  });

  it("agent 定义 model > inherit(父模型被覆盖)", () => {
    expect(getAgentModel("deepseek-v4-flash", "deepseek-v4-pro", undefined)).toBe("deepseek-v4-flash");
  });
});

describe("filterIncompleteToolCalls", () => {
  it("保留所有非 assistant 消息", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    expect(filterIncompleteToolCalls(msgs).length).toBe(2);
  });

  it("过滤未配对 tool_use 的 assistant 消息", () => {
    const assistantWithToolCall: AssistantMessage = {
      role: "assistant",
      content: "let me read",
      tool_calls: [{ id: "tc-1", type: "function", function: { name: "read_file", arguments: "{}" } }],
    };
    const msgs: ChatMessage[] = [
      { role: "user", content: "do it" },
      assistantWithToolCall,
      // 没有 tool result 对应 tc-1
      { role: "assistant", content: "done" },
    ];
    const filtered = filterIncompleteToolCalls(msgs);
    // assistantWithToolCall 应被过滤(有 tool_call 但无对应 tool result)
    const assistants = filtered.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(1);
    expect((assistants[0] as AssistantMessage).content).toBe("done");
  });

  it("保留配对完成的 assistant + tool 消息", () => {
    const assistantWithToolCall: AssistantMessage = {
      role: "assistant",
      content: "let me read",
      tool_calls: [{ id: "tc-1", type: "function", function: { name: "read_file", arguments: "{}" } }],
    };
    const toolResult: ToolMessage = {
      role: "tool",
      tool_call_id: "tc-1",
      content: "file content",
    };
    const msgs: ChatMessage[] = [
      { role: "user", content: "do it" },
      assistantWithToolCall,
      toolResult,
      { role: "assistant", content: "done" },
    ];
    const filtered = filterIncompleteToolCalls(msgs);
    expect(filtered.length).toBe(4);
  });

  it("无 tool_calls 的 assistant 消息保留", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(filterIncompleteToolCalls(msgs).length).toBe(2);
  });
});
