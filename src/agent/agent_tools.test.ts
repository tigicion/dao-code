import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../tools/registry.js";
import { defineTool } from "../tools/types.js";
import { z } from "zod";
import {
  ALL_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  ONE_SHOT_AGENT_TYPES,
  filterToolsForAgent,
  resolveAgentTools,
  createProgressTracker,
  finalizeAgentTool,
} from "./agent_tools.js";
import type { AgentDef } from "./agent_defs.js";

function mkTool(name: string) {
  return defineTool({
    name,
    description: `tool ${name}`,
    schema: z.object({}),
    capability: "read",
    approval: "auto",
    handler: async () => "ok",
  });
}

function mkRegistry(names: string[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const n of names) r.register(mkTool(n));
  return r;
}

const builtinAgent: AgentDef = {
  agentType: "test-builtin",
  whenToUse: "test",
  source: "built-in",
  getSystemPrompt: () => "test",
};

const customAgent: AgentDef = {
  agentType: "test-custom",
  whenToUse: "test",
  source: "userSettings",
  getSystemPrompt: () => "test",
};

describe("ALL_AGENT_DISALLOWED_TOOLS", () => {
  it("包含 agent/ask_user/task_stop", () => {
    expect(ALL_AGENT_DISALLOWED_TOOLS.has("agent")).toBe(true);
    expect(ALL_AGENT_DISALLOWED_TOOLS.has("ask_user")).toBe(true);
    expect(ALL_AGENT_DISALLOWED_TOOLS.has("task_stop")).toBe(true);
  });
});

describe("filterToolsForAgent", () => {
  it("内置 agent 过滤全局禁用工具", () => {
    const r = mkRegistry(["agent", "ask_user", "read_file", "grep_files"]);
    const filtered = filterToolsForAgent({ tools: r, isBuiltIn: true, isAsync: false });
    const names = [...filtered["tools" as never] as Map<string, unknown>].map(([, v]) => (v as { name: string }).name);
    expect(names).not.toContain("agent");
    expect(names).not.toContain("ask_user");
    expect(names).toContain("read_file");
  });

  it("异步 agent 只保留白名单工具", () => {
    const r = mkRegistry(["read_file", "ask_user", "agent", "exec_shell"]);
    const filtered = filterToolsForAgent({ tools: r, isBuiltIn: false, isAsync: true });
    const names = [...filtered["tools" as never] as Map<string, unknown>].map(([, v]) => (v as { name: string }).name);
    expect(names).toContain("read_file");
    expect(names).toContain("exec_shell");
    expect(names).not.toContain("ask_user");
    expect(names).not.toContain("agent");
  });
});

describe("resolveAgentTools", () => {
  it("tools=undefined -> 全部(减禁用)", () => {
    const r = mkRegistry(["read_file", "agent", "grep_files"]);
    const { resolvedTools, hasWildcard } = resolveAgentTools(builtinAgent, r, false);
    expect(hasWildcard).toBe(true);
    // resolvedTools 是 ToolRegistry,检查不含 agent
    const names = [...(resolvedTools as any).tools.keys()];
    expect(names).toContain("read_file");
    expect(names).not.toContain("agent");
  });

  it("tools 白名单 -> 只含白名单", () => {
    const agent: AgentDef = { ...customAgent, tools: ["read_file", "grep_files"] };
    const r = mkRegistry(["read_file", "grep_files", "exec_shell", "agent"]);
    const { resolvedTools, hasWildcard } = resolveAgentTools(agent, r, false);
    expect(hasWildcard).toBe(false);
    const names = [...(resolvedTools as any).tools.keys()];
    expect(names).toEqual(["read_file", "grep_files"]);
  });

  it("disallowedTools 排除", () => {
    const agent: AgentDef = { ...customAgent, disallowedTools: ["exec_shell"] };
    const r = mkRegistry(["read_file", "exec_shell", "grep_files"]);
    const { resolvedTools } = resolveAgentTools(agent, r, false);
    const names = [...(resolvedTools as any).tools.keys()];
    expect(names).not.toContain("exec_shell");
    expect(names).toContain("read_file");
  });
});

describe("createProgressTracker", () => {
  it("初始进度为零", () => {
    const t = createProgressTracker();
    const p = t.getProgress();
    expect(p.tokenCount).toBe(0);
    expect(p.toolUseCount).toBe(0);
  });

  it("累计 assistant 消息的 tool_use", () => {
    const t = createProgressTracker();
    t.updateFromMessage({
      role: "assistant",
      content: "hello",
      tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: "{}" } }],
    } as never);
    expect(t.getProgress().toolUseCount).toBe(1);
  });
});

describe("ONE_SHOT_AGENT_TYPES", () => {
  it("包含 explore 和 plan", () => {
    expect(ONE_SHOT_AGENT_TYPES.has("explore")).toBe(true);
    expect(ONE_SHOT_AGENT_TYPES.has("plan")).toBe(true);
    expect(ONE_SHOT_AGENT_TYPES.has("verify")).toBe(false);
  });
});

describe("finalizeAgentTool", () => {
  it("提取最后一条 assistant 文本", () => {
    const messages = [
      { role: "user" as const, content: "do it" },
      { role: "assistant" as const, content: "working", tool_calls: [] },
      { role: "assistant" as const, content: "done", tool_calls: [] },
    ];
    const result = finalizeAgentTool(messages as never, "agent-1", {
      prompt: "do it",
      model: "test",
      agentType: "test",
      startTime: Date.now() - 1000,
      isAsync: false,
      isBuiltInAgent: false,
    });
    expect(result.content.some((c: any) => c.text === "done")).toBe(true);
    expect(result.agentId).toBe("agent-1");
  });
});
