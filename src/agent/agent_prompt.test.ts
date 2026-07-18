// src/agent/agent_prompt.test.ts
import { describe, it, expect } from "vitest";
import { formatAgentLine, getToolsDescription } from "./agent_prompt.js";
import type { AgentDef } from "./agent_defs.js";

describe("getToolsDescription", () => {
  it("无 tools 无 disallowedTools -> 全部工具", () => {
    const agent: AgentDef = {
      agentType: "test", whenToUse: "test", source: "built-in", getSystemPrompt: () => "",
    };
    expect(getToolsDescription(agent)).toBe("全部工具");
  });

  it("tools = undefined -> 全部工具", () => {
    const agent: AgentDef = {
      agentType: "test", whenToUse: "test", source: "built-in", tools: undefined, getSystemPrompt: () => "",
    };
    expect(getToolsDescription(agent)).toBe("全部工具");
  });

  it("有 tools 白名单 -> 列出工具名", () => {
    const agent: AgentDef = {
      agentType: "test", whenToUse: "test", source: "built-in", tools: ["read_file", "grep_files"], getSystemPrompt: () => "",
    };
    expect(getToolsDescription(agent)).toBe("read_file, grep_files");
  });

  it("有 disallowedTools -> 全部工具除了 X", () => {
    const agent: AgentDef = {
      agentType: "test", whenToUse: "test", source: "built-in", disallowedTools: ["write_file", "exec_shell"], getSystemPrompt: () => "",
    };
    expect(getToolsDescription(agent)).toBe("全部工具除了 write_file, exec_shell");
  });

  it("同时有 tools 和 disallowedTools -> 过滤后列出", () => {
    const agent: AgentDef = {
      agentType: "test", whenToUse: "test", source: "built-in", tools: ["read_file", "grep_files", "write_file"], disallowedTools: ["write_file"], getSystemPrompt: () => "",
    };
    expect(getToolsDescription(agent)).toBe("read_file, grep_files");
  });
});

describe("formatAgentLine", () => {
  it("格式: - <type>: <whenToUse> (Tools: <tools>)", () => {
    const agent: AgentDef = {
      agentType: "explore", whenToUse: "探查子代理", source: "built-in", tools: ["read_file", "grep_files"], getSystemPrompt: () => "",
    };
    const line = formatAgentLine(agent);
    expect(line).toBe("- explore: 探查子代理 (Tools: read_file, grep_files)");
  });

  it("无 tools -> (Tools: 全部工具)", () => {
    const agent: AgentDef = {
      agentType: "general-purpose", whenToUse: "通用子代理", source: "built-in", getSystemPrompt: () => "",
    };
    const line = formatAgentLine(agent);
    expect(line).toContain("全部工具");
  });
});

