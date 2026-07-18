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
      agentType: "test", whenToUse: "test", source: "built-in", tools: ["Read", "Grep"], getSystemPrompt: () => "",
    };
    expect(getToolsDescription(agent)).toBe("Read, Grep");
  });

  it("有 disallowedTools -> 全部工具除了 X", () => {
    const agent: AgentDef = {
      agentType: "test", whenToUse: "test", source: "built-in", disallowedTools: ["Write", "Bash"], getSystemPrompt: () => "",
    };
    expect(getToolsDescription(agent)).toBe("全部工具除了 Write, Bash");
  });

  it("同时有 tools 和 disallowedTools -> 过滤后列出", () => {
    const agent: AgentDef = {
      agentType: "test", whenToUse: "test", source: "built-in", tools: ["Read", "Grep", "Write"], disallowedTools: ["Write"], getSystemPrompt: () => "",
    };
    expect(getToolsDescription(agent)).toBe("Read, Grep");
  });
});

describe("formatAgentLine", () => {
  it("格式: - <type>: <whenToUse> (Tools: <tools>)", () => {
    const agent: AgentDef = {
      agentType: "explore", whenToUse: "探查子代理", source: "built-in", tools: ["Read", "Grep"], getSystemPrompt: () => "",
    };
    const line = formatAgentLine(agent);
    expect(line).toBe("- explore: 探查子代理 (Tools: Read, Grep)");
  });

  it("无 tools -> (Tools: 全部工具)", () => {
    const agent: AgentDef = {
      agentType: "general-purpose", whenToUse: "通用子代理", source: "built-in", getSystemPrompt: () => "",
    };
    const line = formatAgentLine(agent);
    expect(line).toContain("全部工具");
  });
});

