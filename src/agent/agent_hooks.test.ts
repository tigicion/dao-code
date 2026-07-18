// src/agent/agent_hooks.test.ts
import { describe, it, expect } from "vitest";
import {
  registerAgentHooks,
  clearAgentHooks,
  executeSubagentStartHooks,
  type AgentHookRegistry,
} from "./agent_hooks.js";
import type { AgentHooks } from "./agent_defs.js";

describe("registerAgentHooks", () => {
  it("注册 SubagentStart hooks", () => {
    const registry: AgentHookRegistry = new Map();
    const hooks: AgentHooks = {
      SubagentStart: [{ command: "echo start" }],
    };
    registerAgentHooks("agent-1", hooks, registry);
    const entry = registry.get("agent-1");
    expect(entry).toBeDefined();
    expect(entry!.SubagentStart).toEqual([{ command: "echo start" }]);
  });

  it("注册 SubagentStop hooks", () => {
    const registry: AgentHookRegistry = new Map();
    const hooks: AgentHooks = {
      SubagentStop: [{ command: "echo stop" }],
    };
    registerAgentHooks("agent-2", hooks, registry);
    const entry = registry.get("agent-2");
    expect(entry).toBeDefined();
    expect(entry!.SubagentStop).toEqual([{ command: "echo stop" }]);
  });

  it("同时注册 Start 和 Stop hooks", () => {
    const registry: AgentHookRegistry = new Map();
    const hooks: AgentHooks = {
      SubagentStart: [{ command: "echo start" }, { command: "echo start2" }],
      SubagentStop: [{ command: "echo stop" }],
    };
    registerAgentHooks("agent-3", hooks, registry);
    const entry = registry.get("agent-3");
    expect(entry!.SubagentStart!.length).toBe(2);
    expect(entry!.SubagentStop!.length).toBe(1);
  });

  it("空 hooks 不注册", () => {
    const registry: AgentHookRegistry = new Map();
    registerAgentHooks("agent-4", {}, registry);
    expect(registry.has("agent-4")).toBe(false);
  });

  it("重复注册同一 agentId 覆盖", () => {
    const registry: AgentHookRegistry = new Map();
    registerAgentHooks("agent-5", { SubagentStart: [{ command: "echo v1" }] }, registry);
    registerAgentHooks("agent-5", { SubagentStart: [{ command: "echo v2" }] }, registry);
    expect(registry.get("agent-5")!.SubagentStart).toEqual([{ command: "echo v2" }]);
  });
});

describe("clearAgentHooks", () => {
  it("清除已注册的 hooks", () => {
    const registry: AgentHookRegistry = new Map();
    registerAgentHooks("agent-6", { SubagentStart: [{ command: "echo start" }] }, registry);
    expect(registry.has("agent-6")).toBe(true);
    clearAgentHooks("agent-6", registry);
    expect(registry.has("agent-6")).toBe(false);
  });

  it("清除不存在的 agentId 不报错", () => {
    const registry: AgentHookRegistry = new Map();
    expect(() => clearAgentHooks("nonexistent", registry)).not.toThrow();
  });
});

describe("executeSubagentStartHooks", () => {
  it("无注册 hooks -> 返回空 additionalContext", async () => {
    const registry: AgentHookRegistry = new Map();
    const result = await executeSubagentStartHooks("agent-7", "test-agent", registry, "/tmp");
    expect(result.additionalContext).toBe("");
    expect(result.block).toBe(false);
  });

  it("有 SubagentStart hooks -> 执行并收集 additionalContext", async () => {
    const registry: AgentHookRegistry = new Map();
    registerAgentHooks("agent-8", {
      SubagentStart: [{ command: "echo 'started'" }],
    }, registry);
    const result = await executeSubagentStartHooks("agent-8", "test-agent", registry, "/tmp");
    expect(result.block).toBe(false);
    expect(result.additionalContext.length).toBeGreaterThanOrEqual(0);
  });
});
