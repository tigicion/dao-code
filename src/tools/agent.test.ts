import { describe, it, expect, vi } from "vitest";
import { agentTool, normalizeModel } from "./agent.js";
import { createTaskManager } from "../agent/tasks.js";
import type { ChatMessage } from "../client/types.js";
import type { AgentDef } from "../agent/agent_defs.js";

describe("normalizeModel — 子代理模型名兜底", () => {
  it("有效全名保留", () => {
    expect(normalizeModel("deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(normalizeModel("deepseek-v4-flash")).toBe("deepseek-v4-flash");
  });
  it("含 flash/pro 的归一", () => {
    expect(normalizeModel("flash")).toBe("deepseek-v4-flash");
    expect(normalizeModel("Pro")).toBe("deepseek-v4-pro");
  });
  it("无法识别(裸 deepseek-v4 / 乱写)→ undefined 继承父模型,不透传无效名", () => {
    expect(normalizeModel("deepseek-v4")).toBeUndefined();
    expect(normalizeModel("gpt-4")).toBeUndefined();
    expect(normalizeModel(undefined)).toBeUndefined();
  });
});

// ---- 测试用 fake:ctx.runAgent(AsyncGenerator 引擎)----

function fakeRunAgent(resultText: string | ((params: any) => string)) {
  const calls: any[] = [];
  const fn = (params: any): AsyncGenerator<ChatMessage, void> => {
    calls.push(params);
    async function* gen(): AsyncGenerator<ChatMessage, void> {
      const text = typeof resultText === "function" ? resultText(params) : resultText;
      yield { role: "assistant", content: text };
    }
    return gen();
  };
  return { fn, calls };
}

function neverEndingRunAgent() {
  const calls: any[] = [];
  const fn = (params: any): AsyncGenerator<ChatMessage, void> => {
    calls.push(params);
    async function* gen(): AsyncGenerator<ChatMessage, void> {
      await new Promise(() => {}); // 永不完成,逼真模拟"跑很久"
    }
    return gen();
  };
  return { fn, calls };
}

const GENERAL_PURPOSE: AgentDef = {
  agentType: "general-purpose", whenToUse: "", source: "built-in", getSystemPrompt: () => "",
} as AgentDef;

function mkCtx(over: Record<string, unknown> = {}) {
  const { fn } = fakeRunAgent("OK");
  return {
    workspaceRoot: "/tmp",
    readFiles: new Set<string>(),
    subagentDepth: 0,
    agentDefinitions: [GENERAL_PURPOSE],
    runAgent: fn,
    ...over,
  } as any;
}

describe("agent tool", () => {
  it("declares plan capability and auto approval", () => {
    expect(agentTool.capability).toBe("plan");
    expect(agentTool.approval).toBe("auto");
    expect(agentTool.name).toBe("agent");
  });

  it("depth >= 1(子代理内)拒绝派发——agent 工具本就对子代理全局禁用,这里是防御性第二道防线", async () => {
    const { fn, calls } = fakeRunAgent("x");
    const ctx = mkCtx({ subagentDepth: 1, runAgent: fn });
    const out = await agentTool.handler({ task: "x" } as any, ctx);
    expect(out).toContain("不能再派");
    expect(calls).toHaveLength(0);
  });

  it("ctx.runAgent 未配置 → 提示不支持", async () => {
    const ctx = mkCtx({ runAgent: undefined });
    const out = await agentTool.handler({ task: "x" } as any, ctx);
    expect(out).toContain("不支持");
  });

  it("请提供 task 或 tasks", async () => {
    const ctx = mkCtx();
    const out = await agentTool.handler({} as any, ctx);
    expect(out).toContain("请提供");
  });

  it("agent_type 未知 → 提示可用类型", async () => {
    const ctx = mkCtx();
    const out = await agentTool.handler({ task: "x", agent_type: "nope" } as any, ctx);
    expect(out).toContain("未知子代理类型");
    expect(out).toContain("general-purpose");
  });

  it("单个 task → 直接返回结果(无 taskManager 时走直跑不切后台的兜底路径)", async () => {
    const { fn } = fakeRunAgent("单任务结果");
    const ctx = mkCtx({ runAgent: fn });
    const out = await agentTool.handler({ task: "do x" } as any, ctx);
    expect(out).toBe("单任务结果");
  });

  it("agent_type 有效 → 透传给 runAgent(agentDef.agentType 匹配)", async () => {
    const { fn, calls } = fakeRunAgent("审查结果");
    const reviewer: AgentDef = { agentType: "reviewer", whenToUse: "", source: "built-in", getSystemPrompt: () => "" } as AgentDef;
    const ctx = mkCtx({ runAgent: fn, agentDefinitions: [GENERAL_PURPOSE, reviewer] });
    const out = await agentTool.handler({ task: "x", agent_type: "reviewer" } as any, ctx);
    expect(out).toBe("审查结果");
    expect(calls[0].agentDef.agentType).toBe("reviewer");
  });

  it("model/mode 透传进 runAgent 参数", async () => {
    const { fn, calls } = fakeRunAgent("OK");
    const ctx = mkCtx({ runAgent: fn });
    await agentTool.handler({ task: "do x", model: "deepseek-v4-flash", mode: "plan" } as any, ctx);
    expect(calls[0]).toMatchObject({ model: "deepseek-v4-flash", mode: "plan" });
  });

  it("fork + model → 拒绝(跨模型丢缓存)", async () => {
    const { fn, calls } = fakeRunAgent("F");
    const ctx = mkCtx({ runAgent: fn, forkMessages: [{ role: "user", content: "hi" }] });
    const out = await agentTool.handler({ task: "x", fork: true, model: "deepseek-v4-flash" } as any, ctx);
    expect(out).toContain("fork");
    expect(calls).toHaveLength(0);
  });

  it("fork + mode → 拒绝", async () => {
    const { fn } = fakeRunAgent("F");
    const ctx = mkCtx({ runAgent: fn, forkMessages: [] });
    const out = await agentTool.handler({ task: "x", fork: true, mode: "plan" } as any, ctx);
    expect(out).toContain("fork");
  });

  it("fork → 用 FORK_AGENT + useExactTools + 基于 ctx.forkMessages 构建 forkContextMessages", async () => {
    const { fn, calls } = fakeRunAgent("fork结果");
    const parentMessages: ChatMessage[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "父任务" },
      { role: "assistant", content: "父结论" },
    ];
    const ctx = mkCtx({ runAgent: fn, forkMessages: parentMessages });
    const out = await agentTool.handler({ task: "查一下细节", fork: true } as any, ctx);
    expect(out).toBe("fork结果");
    expect(calls[0].useExactTools).toBe(true);
    expect(calls[0].agentDef.agentType).toBe("fork");
    expect(calls[0].forkContextMessages.slice(0, 3)).toEqual(parentMessages);
  });

  it("background:true → 后台启动,立即返回提示不阻塞", async () => {
    const { fn: neverFn, calls } = neverEndingRunAgent();
    const taskManager = createTaskManager();
    const ctx = mkCtx({ runAgent: neverFn, taskManager });
    const out = await agentTool.handler({ task: "耗时调查", background: true } as any, ctx);
    expect(out).toContain("已后台启动");
    expect(calls).toHaveLength(1);
    expect(calls[0].isAsync).toBe(true);
  });

  it("background + model → 显式拒绝(不静默丢)", async () => {
    const ctx = mkCtx();
    const out = await agentTool.handler({ task: "x", background: true, model: "deepseek-v4-flash" } as any, ctx);
    expect(out).toContain("background");
  });

  it("单前台子代理超时 → 自动转后台", async () => {
    const prev = process.env.DAO_AUTO_BACKGROUND_MS;
    process.env.DAO_AUTO_BACKGROUND_MS = "10";
    const { fn } = neverEndingRunAgent();
    const taskManager = createTaskManager();
    const ctx = mkCtx({ runAgent: fn, taskManager });
    const out = await agentTool.handler({ task: "慢任务" } as any, ctx);
    process.env.DAO_AUTO_BACKGROUND_MS = prev;
    expect(out).toContain("自动转入后台");
  });

  it("tasks 数组 → 并行派发并汇总", async () => {
    const { fn } = fakeRunAgent((params) => `R:${params.promptMessages[0].content}`);
    const ctx = mkCtx({ runAgent: fn });
    const out = await agentTool.handler({ tasks: ["A", "B", "C"] } as any, ctx);
    expect(out).toContain("子代理 1/3");
    expect(out).toContain("R:A");
    expect(out).toContain("R:B");
    expect(out).toContain("R:C");
  });

  it("并发限流:>10 个任务最多 10 个同时跑,其余排队,全部完成", async () => {
    let active = 0, maxActive = 0;
    const fn = (params: any): AsyncGenerator<ChatMessage, void> => {
      async function* gen(): AsyncGenerator<ChatMessage, void> {
        active++; maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        yield { role: "assistant", content: `R:${params.promptMessages[0].content}` };
      }
      return gen();
    };
    const tasks = Array.from({ length: 15 }, (_, i) => `t${i}`);
    const ctx = mkCtx({ runAgent: fn });
    const out = await agentTool.handler({ tasks } as any, ctx);
    expect(maxActive).toBeLessThanOrEqual(10);
    expect(maxActive).toBeGreaterThan(1);
    expect(out).toContain("子代理 15/15");
    expect(out).toContain("R:t14");
  });

  it("并行中单个失败不影响其余", async () => {
    const fn = (params: any): AsyncGenerator<ChatMessage, void> => {
      async function* gen(): AsyncGenerator<ChatMessage, void> {
        const t = params.promptMessages[0].content as string;
        if (t === "bad") throw new Error("炸了");
        yield { role: "assistant", content: `R:${t}` };
      }
      return gen();
    };
    const ctx = mkCtx({ runAgent: fn });
    const out = await agentTool.handler({ tasks: ["ok", "bad"] } as any, ctx);
    expect(out).toContain("R:ok");
    expect(out).toContain("[失败] 炸了");
  });

  it("isolate → 用 worktree 隔离跑,有改动时保留分支提示,无改动时清理", async () => {
    const { fn, calls } = fakeRunAgent("改完了");
    const cleanup = vi.fn();
    const ctx = mkCtx({
      runAgent: fn,
      createWorktree: () => ({ root: "/tmp/wt-1", branch: "agent/wt-1", cleanup, hasChanges: () => true }),
    });
    const out = await agentTool.handler({ task: "改个文件", isolate: true } as any, ctx);
    expect(out).toContain("改完了");
    expect(out).toContain("agent/wt-1");
    expect(calls[0].worktreePath).toBe("/tmp/wt-1");
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("isolate 无改动 → 自动清理 worktree,不留垃圾分支", async () => {
    const { fn } = fakeRunAgent("看了一下没改");
    const cleanup = vi.fn();
    const ctx = mkCtx({
      runAgent: fn,
      createWorktree: () => ({ root: "/tmp/wt-2", branch: "agent/wt-2", cleanup, hasChanges: () => false }),
    });
    const out = await agentTool.handler({ task: "看一下", isolate: true } as any, ctx);
    expect(out).toBe("看了一下没改");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
