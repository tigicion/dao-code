// src/agent/fork_agent.test.ts
import { describe, it, expect } from "vitest";
import {
  FORK_AGENT,
  FORK_BOILERPLATE_TAG,
  FORK_DIRECTIVE_PREFIX,
  buildForkedMessages,
  buildChildMessage,
  buildWorktreeNotice,
  isInForkChild,
} from "./fork_agent.js";
import type { ChatMessage, AssistantMessage, UserMessage } from "../client/types.js";

describe("FORK_AGENT", () => {
  it("agentType = fork", () => {
    expect(FORK_AGENT.agentType).toBe("fork");
  });

  it("model = inherit", () => {
    expect(FORK_AGENT.model).toBe("inherit");
  });

  it("source = built-in", () => {
    expect(FORK_AGENT.source).toBe("built-in");
  });

  it("getSystemPrompt 返回空字符串(实际用父的)", () => {
    expect(FORK_AGENT.getSystemPrompt({} as never)).toBe("");
  });

  it("tools = undefined(useExactTools 直接拿父的工具池)", () => {
    expect(FORK_AGENT.tools).toBeUndefined();
  });
});

describe("buildChildMessage", () => {
  it("包含 fork-boilerplate 标签", () => {
    const msg = buildChildMessage("调查缓存命中率");
    expect(msg).toContain(`<${FORK_BOILERPLATE_TAG}>`);
    expect(msg).toContain(`</${FORK_BOILERPLATE_TAG}>`);
  });

  it("包含 directive 前缀和内容", () => {
    const msg = buildChildMessage("调查缓存命中率");
    expect(msg).toContain(FORK_DIRECTIVE_PREFIX);
    expect(msg).toContain("调查缓存命中率");
  });

  it("包含结构化输出格式(范围/结果/关键文件/改动文件/问题)", () => {
    const msg = buildChildMessage("测试指令");
    expect(msg).toContain("范围:");
    expect(msg).toContain("结果:");
    expect(msg).toContain("关键文件:");
    expect(msg).toContain("改动文件:");
    expect(msg).toContain("问题:");
  });

  it("包含防递归规则(不能再 fork)", () => {
    const msg = buildChildMessage("test");
    expect(msg).toContain("不要再派子代理");
  });
});

describe("buildForkedMessages", () => {
  it("无 tool_calls 的 assistant -> 只返回 directive 消息", () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      content: "hello",
      tool_calls: [],
    };
    const result = buildForkedMessages("do something", assistant);
    expect(result.length).toBe(1);
    expect(result[0]!.role).toBe("user");
  });

  it("有 tool_calls -> 返回 [assistant, user(tool_results + directive)]", () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      content: "let me check",
      tool_calls: [
        { id: "tc-1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
        { id: "tc-2", type: "function", function: { name: "grep_files", arguments: '{"pattern":"foo"}' } },
      ],
    };
    const result = buildForkedMessages("调查 foo", assistant);
    expect(result.length).toBe(2);
    expect(result[0]!.role).toBe("assistant");
    const userMsg = result[1] as UserMessage;
    expect(userMsg.role).toBe("user");
    expect(Array.isArray(userMsg.content)).toBe(true);
  });
});

describe("isInForkChild", () => {
  it("消息含 fork-boilerplate 标签 -> true", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: `<${FORK_BOILERPLATE_TAG}>STOP</${FORK_BOILERPLATE_TAG}>` },
    ];
    expect(isInForkChild(msgs)).toBe(true);
  });

  it("消息不含 fork-boilerplate 标签 -> false", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "普通用户消息" },
    ];
    expect(isInForkChild(msgs)).toBe(false);
  });

  it("空消息列表 -> false", () => {
    expect(isInForkChild([])).toBe(false);
  });

  it("ContentPart 数组中含标签 -> true", () => {
    const msgs: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: `<${FORK_BOILERPLATE_TAG}>directive</${FORK_BOILERPLATE_TAG}>` },
        ],
      },
    ];
    expect(isInForkChild(msgs)).toBe(true);
  });
});

describe("buildWorktreeNotice", () => {
  it("包含父路径和 worktree 路径", () => {
    const notice = buildWorktreeNotice("/home/user/project", "/home/user/.dao/worktrees/abc");
    expect(notice).toContain("/home/user/project");
    expect(notice).toContain("/home/user/.dao/worktrees/abc");
  });

  it("包含路径翻译提示", () => {
    const notice = buildWorktreeNotice("/parent", "/worktree");
    expect(notice).toContain("翻译");
  });
});
