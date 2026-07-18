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
      tool_calls: [{ id: "tc-1", type: "function", function: { name: "Read", arguments: "{}" } }],
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
      tool_calls: [{ id: "tc-1", type: "function", function: { name: "Read", arguments: "{}" } }],
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
    expect(capturedMessages![0]).toEqual({ role: "system", content: expect.stringContaining("我是子代理系统提示") });
  });

  it("内置 agent 默认(omitClaudeMd 未设)拼上父级 projectInstructions(否则子代理完全拿不到 CLAUDE.md/项目上下文)", async () => {
    let capturedMessages: ChatMessage[] | undefined;
    const params = baseParams({
      agentDef: { agentType: "general-purpose", whenToUse: "", source: "built-in", getSystemPrompt: () => "我是通用子代理" } as BuiltInAgentDef,
      projectInstructions: "# 项目须知\n用 TypeScript,遵守 CLAUDE.md",
      runTurn: async (deps) => {
        capturedMessages = [...deps.session.messages];
        deps.session.messages.push({ role: "assistant", content: "done" });
      },
    });
    await drain(runAgent(params));
    const sysText = typeof capturedMessages![0]!.content === "string" ? capturedMessages![0]!.content as string : "";
    expect(sysText).toContain("项目须知");
    expect(sysText).toContain("我是通用子代理");
  });

  it("agentDef.omitClaudeMd=true 时不拼 projectInstructions(explore/plan 省 token,只留自己的角色 prompt)", async () => {
    let capturedMessages: ChatMessage[] | undefined;
    const params = baseParams({
      agentDef: { agentType: "explore", whenToUse: "", source: "built-in", omitClaudeMd: true, getSystemPrompt: () => "我是探查子代理" } as BuiltInAgentDef,
      projectInstructions: "# 项目须知\n用 TypeScript,遵守 CLAUDE.md",
      runTurn: async (deps) => {
        capturedMessages = [...deps.session.messages];
        deps.session.messages.push({ role: "assistant", content: "done" });
      },
    });
    await drain(runAgent(params));
    const sysText = typeof capturedMessages![0]!.content === "string" ? capturedMessages![0]!.content as string : "";
    expect(sysText).not.toContain("项目须知");
    expect(sysText).toContain("我是探查子代理");
  });

  it("agentDef.memory 设置时:system prompt 追加记忆说明 + 强制找回被 disallowedTools 排除的 read/write/edit 工具", async () => {
    const pool = new ToolRegistry();
    for (const n of ["Read", "Write", "Edit", "Grep"]) pool.register(mkTool(n));
    let capturedMessages: ChatMessage[] | undefined;
    let capturedRegistry: ToolRegistry | undefined;
    const params = baseParams({
      agentDef: {
        agentType: "mem-agent", whenToUse: "", source: "built-in", memory: "project",
        disallowedTools: ["Read", "Write", "Edit"],
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
    expect(capturedRegistry!.get("Read")).toBeDefined();
    expect(capturedRegistry!.get("Write")).toBeDefined();
    expect(capturedRegistry!.get("Edit")).toBeDefined();
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

  it("调用级 mode 覆盖 agentDef.permissionMode(优先级:调用级 > agentDef > normal)", async () => {
    let capturedMode: string | undefined;
    const params = baseParams({
      agentDef: { agentType: "t", whenToUse: "", source: "built-in", permissionMode: "normal", getSystemPrompt: () => "SYS" } as BuiltInAgentDef,
      mode: "plan",
      runTurn: async (deps) => {
        capturedMode = deps.session.mode;
        deps.session.messages.push({ role: "assistant", content: "done" });
      },
    });
    await drain(runAgent(params));
    expect(capturedMode).toBe("plan");
  });

  it("未传调用级 mode 时,回退到 agentDef.permissionMode", async () => {
    let capturedMode: string | undefined;
    const params = baseParams({
      agentDef: { agentType: "t", whenToUse: "", source: "built-in", permissionMode: "plan", getSystemPrompt: () => "SYS" } as BuiltInAgentDef,
      runTurn: async (deps) => {
        capturedMode = deps.session.mode;
        deps.session.messages.push({ role: "assistant", content: "done" });
      },
    });
    await drain(runAgent(params));
    expect(capturedMode).toBe("plan");
  });

  it("messageParent 透传进子代理的 subCtx(后台子代理给父发 mid-run 消息用)", async () => {
    let capturedMessageParent: ((m: string) => void) | undefined;
    const mp = () => {};
    const params = baseParams({
      messageParent: mp,
      runTurn: async (deps) => {
        capturedMessageParent = deps.ctx.messageParent;
        deps.session.messages.push({ role: "assistant", content: "done" });
      },
    });
    await drain(runAgent(params));
    expect(capturedMessageParent).toBe(mp);
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

  it("onCacheSafeParams 传的是 sub.messages 引用(随 runTurn 增长),不是 initialMessages 静态快照", async () => {
    let capturedRef: ChatMessage[] | undefined;
    const params = baseParams({
      onCacheSafeParams: (p) => { capturedRef = p.forkContextMessages; },
      runTurn: async (deps) => {
        // 回调已经在阶段 4 触发了,此刻 capturedRef 应指向 sub.messages
        // runTurn 还没 push 新消息,长度应等于初始消息数
        expect(capturedRef).toBeDefined();
        const lenBefore = capturedRef!.length;
        deps.session.messages.push({ role: "assistant", content: "done" });
        // push 后 capturedRef 应同步增长(同一引用)
        expect(capturedRef!.length).toBe(lenBefore + 1);
      },
    });
    await drain(runAgent(params));
    // 跑完后 capturedRef 应包含 runTurn push 的消息
    expect(capturedRef!.some((m) => m.role === "assistant")).toBe(true);
  });

  it("消息在 runTurn 期间逐条 yield(而非跑完后一次性),验证流式", async () => {
    // runTurn 分两阶段 push 消息,中间等一下--如果 runAgent 是流式的,
    // 第一条消息应该在 runTurn 还没返回时就能 yield 出来。
    let firstMessageYielded = false;
    let runTurnReturned = false;
    const params = baseParams({
      runTurn: async (deps) => {
        deps.session.messages.push({ role: "assistant", content: "第一条" });
        // 等一小段时间,让轮询有机会 yield
        await new Promise((r) => setTimeout(r, 50));
        deps.session.messages.push({ role: "assistant", content: "第二条" });
        runTurnReturned = true;
      },
    });
    const out: ChatMessage[] = [];
    for await (const m of runAgent(params)) {
      out.push(m);
      if (out.length === 1) firstMessageYielded = !runTurnReturned; // 第一条 yield 时 runTurn 还没返回
    }
    expect(out.length).toBe(2);
    expect(out[0]!.content).toBe("第一条");
    expect(out[1]!.content).toBe("第二条");
    expect(firstMessageYielded).toBe(true); // 第一条在 runTurn 返回前就 yield 了
  });

  it("runTurn 抛错 -> 已 yield 的消息不丢,错误重新抛出", async () => {
    const params = baseParams({
      runTurn: async (deps) => {
        deps.session.messages.push({ role: "assistant", content: "成功消息" });
        await new Promise((r) => setTimeout(r, 50));
        throw new Error("runTurn 炸了");
      },
    });
    const out: ChatMessage[] = [];
    let caught: Error | undefined;
    try {
      for await (const m of runAgent(params)) out.push(m);
    } catch (e) {
      caught = e as Error;
    }
    expect(out.length).toBe(1); // 成功消息不丢
    expect(out[0]!.content).toBe("成功消息");
    expect(caught!.message).toBe("runTurn 炸了");
  });

  it("同步子代理也拿到真实 abortController(此前 isAsync:false 时 signal 恒 undefined,TaskStop/cancel 无 controller 可 abort)", async () => {
    let capturedSignal: AbortSignal | undefined;
    const params = baseParams({
      isAsync: false,
      runTurn: async (deps) => {
        capturedSignal = deps.signal;
        deps.session.messages.push({ role: "assistant", content: "done" });
      },
    });
    for await (const _m of runAgent(params)) { /* drain */ }
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal!.aborted).toBe(false);
  });

  it("同步子代理链上父的 signal:父在子还没跑完时 abort,子的 signal 也 abort(保留'父 ESC 连带杀子'的原行为)", async () => {
    // 注意:必须在 runTurn 执行期间(finally 清理之前)观察 abort 传导——子代理跑完后
    // finally 会主动解绑这条监听器(修复了监听器永久挂在父 signal 上的泄漏),所以"跑完之后
    // 父再 abort"不该再影响已经结束的子代理,这里验证的是"还在跑的时候"父 abort 会连带杀子。
    const parentAbort = new AbortController();
    let observedAbortDuringRun = false;
    const params = baseParams({
      isAsync: false,
      toolUseContext: { workspaceRoot: "/tmp", signal: parentAbort.signal },
      runTurn: async (deps) => {
        expect(deps.signal!.aborted).toBe(false);
        parentAbort.abort();
        observedAbortDuringRun = deps.signal!.aborted;
        deps.session.messages.push({ role: "assistant", content: "done" });
      },
    });
    for await (const _m of runAgent(params)) { /* drain */ }
    expect(observedAbortDuringRun).toBe(true);
  });

  it("跑完之后清理监听器:子代理正常结束后,父再 abort 不再影响它(修复监听器永久挂在父 signal 上的泄漏)", async () => {
    const parentAbort = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const params = baseParams({
      isAsync: false,
      toolUseContext: { workspaceRoot: "/tmp", signal: parentAbort.signal },
      runTurn: async (deps) => {
        capturedSignal = deps.signal;
        deps.session.messages.push({ role: "assistant", content: "done" });
      },
    });
    for await (const _m of runAgent(params)) { /* drain */ }
    parentAbort.abort(); // 子代理早就跑完了,这次 abort 不该再传导
    expect(capturedSignal!.aborted).toBe(false);
  });

  it("调用方传入 override.abortController 时(前台路径由 agent.ts 自己管父信号链,不走 runAgent 内部兜底链),不重复挂监听器,但独立 abort 依然生效", async () => {
    const parentAbort = new AbortController();
    const ownController = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const params = baseParams({
      isAsync: false,
      toolUseContext: { workspaceRoot: "/tmp", signal: parentAbort.signal },
      override: { abortController: ownController },
      runTurn: async (deps) => {
        capturedSignal = deps.signal;
        deps.session.messages.push({ role: "assistant", content: "done" });
      },
    });
    for await (const _m of runAgent(params)) { /* drain */ }
    expect(capturedSignal).toBe(ownController.signal);
    // 独立 abort(模拟 taskManager.cancel())依然生效,不需要父也一起死
    ownController.abort();
    expect(capturedSignal!.aborted).toBe(true);
  });
});
