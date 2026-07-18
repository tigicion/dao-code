import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { getAgentModel, filterIncompleteToolCalls, runAgent, type RunAgentParams } from "./runAgent.js";
import { getAgentTranscript } from "./resume_agent.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import type { ApprovalGate } from "../approval/types.js";
import type { TurnDeps } from "./loop.js";
import type { ChatMessage, AssistantMessage, ToolMessage } from "../client/types.js";
import type { BuiltInAgentDef } from "./agent_defs.js";

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

// ---- 集成测试:阶段 2/3/4/7 接线(memory/hooks/worktree/subagentsDir/system 消息) ----

const stubGate: ApprovalGate = { decide: () => "allow", decideAsync: async () => "allow", requestBatch: async () => new Map() };

function mkTool(name: string): Tool {
  return { name, description: name, schema: z.object({}), handler: async () => "" } as unknown as Tool;
}

function baseParams(overrides: Partial<RunAgentParams>): RunAgentParams {
  return {
    agentDef: { agentType: "t", whenToUse: "", source: "built-in", getSystemPrompt: () => "SYS" } as BuiltInAgentDef,
    promptMessages: [{ role: "user", content: "do it" }],
    toolUseContext: { workspaceRoot: "/tmp" },
    isAsync: false,
    config: { baseUrl: "", apiKey: "" },
    streamChat: (() => {}) as unknown as TurnDeps["streamChat"],
    executeToolCalls: async () => [],
    gate: stubGate,
    runTurn: async (deps) => { deps.session.messages.push({ role: "assistant", content: "done" }); },
    write: () => {},
    ...overrides,
  };
}

async function drain(gen: AsyncGenerator<ChatMessage, void>): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  for await (const m of gen) out.push(m);
  return out;
}

describe("runAgent 阶段接线", () => {
  it("非 fork 路径:system 消息不再从 session.messages 里丢失(旧 bug:整体替换丢了 Session 构造函数塞的 system)", async () => {
    let capturedMessages: ChatMessage[] | undefined;
    const params = baseParams({
      agentDef: { agentType: "t", whenToUse: "", source: "built-in", getSystemPrompt: () => "我是子代理系统提示" } as BuiltInAgentDef,
      runTurn: async (deps) => {
        capturedMessages = [...deps.session.messages];
        deps.session.messages.push({ role: "assistant", content: "done" });
      },
    });
    await drain(runAgent(params));
    expect(capturedMessages![0]).toEqual({ role: "system", content: "我是子代理系统提示" });
  });

  it("agentDef.memory 设置时:system prompt 追加记忆说明 + 强制找回被 disallowedTools 排除的 read/write/edit 工具", async () => {
    const pool = new ToolRegistry();
    for (const n of ["read_file", "write_file", "edit_file", "grep_files"]) pool.register(mkTool(n));
    let capturedMessages: ChatMessage[] | undefined;
    let capturedRegistry: ToolRegistry | undefined;
    const params = baseParams({
      agentDef: {
        agentType: "mem-agent", whenToUse: "", source: "built-in", memory: "project",
        disallowedTools: ["read_file", "write_file", "edit_file"],
        getSystemPrompt: () => "SYS",
      } as BuiltInAgentDef,
      availableTools: pool,
      runTurn: async (deps) => {
        capturedMessages = [...deps.session.messages];
        capturedRegistry = deps.registry;
        deps.session.messages.push({ role: "assistant", content: "done" });
      },
    });
    await drain(runAgent(params));
    expect(capturedRegistry!.get("read_file")).toBeDefined();
    expect(capturedRegistry!.get("write_file")).toBeDefined();
    expect(capturedRegistry!.get("edit_file")).toBeDefined();
    const sysText = typeof capturedMessages![0]!.content === "string" ? capturedMessages![0]!.content as string : "";
    expect(sysText).toContain("持久 Agent 记忆");
  });

  it("agentDef.hooks.SubagentStart 的 additionalContext 作为消息注入", async () => {
    let capturedMessages: ChatMessage[] | undefined;
    const params = baseParams({
      agentDef: {
        agentType: "hook-agent", whenToUse: "", source: "built-in",
        hooks: { SubagentStart: [{ command: "echo '来自hook的上下文'" }] },
        getSystemPrompt: () => "SYS",
      } as BuiltInAgentDef,
      runTurn: async (deps) => {
        capturedMessages = [...deps.session.messages];
        deps.session.messages.push({ role: "assistant", content: "done" });
      },
    });
    await drain(runAgent(params));
    const joined = capturedMessages!.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(joined).toContain("来自hook的上下文");
  });

  it("agentDef.hooks.SubagentStop 在 finally 里真的执行(用真实命令验证接线,而非只留注释)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dao-hook-stop-"));
    const marker = path.join(dir, "stopped.txt");
    const params = baseParams({
      agentDef: {
        agentType: "hook-agent", whenToUse: "", source: "built-in",
        hooks: { SubagentStop: [{ command: `touch ${marker}` }] },
        getSystemPrompt: () => "SYS",
      } as BuiltInAgentDef,
    });
    await drain(runAgent(params));
    await new Promise((r) => setTimeout(r, 50)); // hook 命令异步执行,给它一点时间落盘
    expect(existsSync(marker)).toBe(true);
  });

  it("worktreePath 覆盖子代理的 workspaceRoot", async () => {
    let capturedWorkspaceRoot: string | undefined;
    const params = baseParams({
      worktreePath: "/tmp/some-worktree",
      runTurn: async (deps) => {
        capturedWorkspaceRoot = deps.ctx.workspaceRoot;
        deps.session.messages.push({ role: "assistant", content: "done" });
      },
    });
    await drain(runAgent(params));
    expect(capturedWorkspaceRoot).toBe("/tmp/some-worktree");
  });

  it("subagentsDir 透传:转录写到指定目录,而不是 process.cwd() 硬编码", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dao-subagentsdir-"));
    const params = baseParams({
      subagentsDir: dir,
      override: { agentId: "fixed-agent-id" },
    });
    await drain(runAgent(params));
    await new Promise((r) => setTimeout(r, 20));
    const transcript = await getAgentTranscript(dir, "fixed-agent-id");
    expect(transcript).not.toBeNull();
    expect(transcript!.messages.some((m) => m.role === "assistant")).toBe(true);
  });
});
