import { describe, it, expect, vi } from "vitest";
import { agentTool, normalizeModel } from "./agent.js";
import { createTaskManager } from "../agent/tasks.js";
import { createForegroundRegistry } from "../tui/foreground_registry.js";
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
  it("无法识别(裸 deepseek-v4 / 乱写)-> undefined 继承父模型,不透传无效名", () => {
    expect(normalizeModel("deepseek-v4")).toBeUndefined();
    expect(normalizeModel("gpt-4")).toBeUndefined();
    expect(normalizeModel(undefined)).toBeUndefined();
  });
  it("多 provider 模型名原样保留(不归一化成 undefined)", () => {
    expect(normalizeModel("kimi-k2.6")).toBe("kimi-k2.6");
    expect(normalizeModel("glm-5.2")).toBe("glm-5.2");
    expect(normalizeModel("doubao-seed-2.0-pro")).toBe("doubao-seed-2.0-pro");
    expect(normalizeModel("ernie-5.1")).toBe("ernie-5.1");
  });
  it("大小写不敏感但保留原始大小写", () => {
    expect(normalizeModel("Kimi-K2.6")).toBe("Kimi-K2.6");
    expect(normalizeModel("GLM-5.2")).toBe("GLM-5.2");
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
    expect(agentTool.name).toBe("Agent");
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

  it("background 子代理调用 messageParent → 进父的任务通知队列(MessageParent 工具的唯一出口)", async () => {
    const fn = (params: any): AsyncGenerator<ChatMessage, void> => {
      async function* gen(): AsyncGenerator<ChatMessage, void> {
        params.messageParent?.("跑到一半了");
        yield { role: "assistant", content: "done" };
      }
      return gen();
    };
    const taskManager = createTaskManager();
    const ctx = mkCtx({ runAgent: fn, taskManager });
    const out = await agentTool.handler({ task: "耗时调查", background: true } as any, ctx);
    expect(out).toContain("已后台启动");
    expect(taskManager.drainNotifications().join("\n")).toContain("跑到一半了");
  });

  it("background + model → 显式拒绝(不静默丢)", async () => {
    const ctx = mkCtx();
    const out = await agentTool.handler({ task: "x", background: true, model: "deepseek-v4-flash" } as any, ctx);
    expect(out).toContain("background");
  });

  it("父 abort → 直接中止还在跑的前台子代理(没有自动转后台这条路,ESC 立刻生效,不用等超时)", async () => {
    const calls: any[] = [];
    const fn = (params: any): AsyncGenerator<ChatMessage, void> => {
      calls.push(params);
      async function* gen(): AsyncGenerator<ChatMessage, void> {
        const signal: AbortSignal = params.override.abortController.signal;
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) { reject(new Error("aborted")); return; }
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return gen();
    };
    const taskManager = createTaskManager();
    const parentAbort = new AbortController();
    const ctx = mkCtx({ runAgent: fn, taskManager, signal: parentAbort.signal });
    const p = agentTool.handler({ task: "慢任务" } as any, ctx);
    await Promise.resolve(); // 让 handler 跑到 registerAgentForeground + 挂上父信号监听器再 abort
    parentAbort.abort();
    const { abortController } = calls[0]!.override;
    expect(abortController.signal.aborted).toBe(true); // 没有"转后台"这条岔路,父 abort 直接传导下去
    await expect(p).rejects.toThrow("aborted");
  });

  it("前台任务正常跑完 → taskManager 里状态结算为 completed(不留 running,不被 cancelAll/TaskStop 误伤)", async () => {
    const { fn } = fakeRunAgent("单任务结果");
    const taskManager = createTaskManager();
    const ctx = mkCtx({ runAgent: fn, taskManager });
    const out = await agentTool.handler({ task: "do x" } as any, ctx);
    expect(out).toBe("单任务结果");
    const all = taskManager.all();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("completed");
  });

  it("前台任务抛错 → taskManager 结算为 failed(不留 running),错误照常抛给调用方", async () => {
    const fn = (): AsyncGenerator<ChatMessage, void> => {
      async function* gen(): AsyncGenerator<ChatMessage, void> {
        throw new Error("炸了");
      }
      return gen();
    };
    const taskManager = createTaskManager();
    const ctx = mkCtx({ runAgent: fn, taskManager });
    await expect(agentTool.handler({ task: "x" } as any, ctx)).rejects.toThrow("炸了");
    const all = taskManager.all();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("failed");
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
      createWorktree: () => ({ root: "/tmp/wt-1", branch: "agent/wt-1", cleanup, hasChanges: () => true, hasUnpushedCommits: () => false }),
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
      createWorktree: () => ({ root: "/tmp/wt-2", branch: "agent/wt-2", cleanup, hasChanges: () => false, hasUnpushedCommits: () => false }),
    });
    const out = await agentTool.handler({ task: "看一下", isolate: true } as any, ctx);
    expect(out).toBe("看了一下没改");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("isolate:子代理在 worktree 里提交过、工作区干净但分支上有原分支没有的提交 → 不能自动清理,要保留", async () => {
    // 真实撞见的同一类缺口:子代理如果自己在 worktree 里 commit 了(隔离改文件的正常用法之一),
    // 工作区会变干净,hasChanges() 单独看不出来——旧逻辑会把这种情况误判成"无改动"直接删掉分支,
    // 已提交的工作跟着 cleanup() 的 git branch -D 一起消失。
    const { fn } = fakeRunAgent("改完了并且提交了");
    const cleanup = vi.fn();
    const ctx = mkCtx({
      runAgent: fn,
      createWorktree: () => ({ root: "/tmp/wt-3", branch: "agent/wt-3", cleanup, hasChanges: () => false, hasUnpushedCommits: () => true }),
    });
    const out = await agentTool.handler({ task: "改个文件并提交", isolate: true } as any, ctx);
    expect(out).toContain("agent/wt-3");
    expect(cleanup).not.toHaveBeenCalled();
  });

  // ---- handoff 安全审查接线测试 ----

  it("auto 模式同步路径 -> 调 handoffClassifyFn,返回结果前缀警告", async () => {
    const { fn } = fakeRunAgent("done");
    let called = false;
    const ctx = mkCtx({
      runAgent: fn,
      permissionMode: "auto",
      handoffClassifyFn: async () => { called = true; return { shouldBlock: true, reason: "删了文件" }; },
    });
    const out = await agentTool.handler({ task: "x" } as any, ctx);
    expect(called).toBe(true);
    expect(out).toContain("安全警告");
    expect(out).toContain("删了文件");
    expect(out).toContain("done");
  });

  it("非 auto 模式同步路径 -> 不调 handoffClassifyFn", async () => {
    const { fn } = fakeRunAgent("done");
    let called = false;
    const ctx = mkCtx({
      runAgent: fn,
      permissionMode: "default",
      handoffClassifyFn: async () => { called = true; return { shouldBlock: false }; },
    });
    const out = await agentTool.handler({ task: "x" } as any, ctx);
    expect(called).toBe(false);
    expect(out).toBe("done");
  });

  it("auto 模式 handoff allowed -> 不前缀警告,原样返回", async () => {
    const { fn } = fakeRunAgent("clean");
    const ctx = mkCtx({
      runAgent: fn,
      permissionMode: "auto",
      handoffClassifyFn: async () => ({ shouldBlock: false }),
    });
    const out = await agentTool.handler({ task: "x" } as any, ctx);
    expect(out).toBe("clean");
  });

  it("auto 模式后台路径 -> 传了 classifyFn + permissionMode 给 runAsyncAgentLifecycle", async () => {
    const { fn: neverFn } = neverEndingRunAgent();
    const taskManager = createTaskManager();
    const ctx = mkCtx({
      runAgent: neverFn,
      taskManager,
      permissionMode: "auto",
      handoffClassifyFn: async () => ({ shouldBlock: false }),
    });
    // 只验证不报错(后台路径立即返回),classifyFn 会在子代理完成后才被调
    const out = await agentTool.handler({ task: "耗时", background: true } as any, ctx);
    expect(out).toContain("已后台启动");
  });

  // ---- Ctrl+B 转后台 ----

  it("注册表触发转后台回调后:abort 先于 return 被调用、已产出消息复用为续接的 forkContextMessages、原任务结算 completed、新任务在 taskManager 里处于 running", async () => {
    const producedMessages: ChatMessage[] = [{ role: "assistant", content: "在做第一步" }];
    let abortedAt = -1;
    let returnedAt = -1;
    let seq = 0;
    const foregroundCalls: any[] = [];
    const restartCalls: any[] = [];
    const fn = (params: any): AsyncGenerator<ChatMessage, void> => {
      if (params.isAsync === false) {
        foregroundCalls.push(params);
        async function* gen(): AsyncGenerator<ChatMessage, void> {
          try {
            for (const m of producedMessages) yield m;
            const signal: AbortSignal = params.override.abortController.signal;
            await new Promise<void>((resolve) => {
              if (signal.aborted) { abortedAt = seq++; resolve(); return; }
              signal.addEventListener("abort", () => { abortedAt = seq++; resolve(); }, { once: true });
            });
          } finally {
            returnedAt = seq++;
          }
        }
        return gen();
      }
      restartCalls.push(params);
      async function* gen(): AsyncGenerator<ChatMessage, void> {
        yield { role: "assistant", content: "续接完成" };
      }
      return gen();
    };

    const registry = createForegroundRegistry();
    const taskManager = createTaskManager();
    const ctx = mkCtx({ runAgent: fn, taskManager, foregroundRegistry: registry });
    const resultPromise = agentTool.handler({ task: "do it" } as any, ctx);
    // 让 runOne 跑到把 producedMessages 都 yield 完、卡在等 abort 那一步,再模拟用户按 Ctrl+B。
    await new Promise((r) => setTimeout(r, 20));
    const n = registry.convertAll();
    expect(n).toBe(1);
    const result = await resultPromise;

    expect(result).toContain("已转后台");
    expect(abortedAt).toBe(0); // abort 先于 return 触发,顺序不能反(设计文档副作用核查)
    expect(returnedAt).toBe(1); // 生成器的 finally 确实跑了,等价于 .return() 生效、清理完成
    expect(restartCalls).toHaveLength(1);
    expect(restartCalls[0].promptMessages).toEqual([]);
    expect(restartCalls[0].forkContextMessages).toEqual(producedMessages); // 复用已产出消息续接
    expect(restartCalls[0].isAsync).toBe(true);

    const oldAgentId = foregroundCalls[0].override.agentId;
    const newAgentId = restartCalls[0].override.agentId;
    expect(newAgentId).not.toBe(oldAgentId); // 新起一个 id,不复用旧的(旧的已经 settle 结束)
    expect(taskManager.get(oldAgentId)?.status).toBe("completed"); // 前台生命周期正常结算,不留 running
    const running = taskManager.running();
    expect(running).toHaveLength(1);
    expect(running[0]!.id).toBe(newAgentId); // 新任务在 taskManager 里确实处于 running,可被 TaskOutput/TaskStop 管理
  });

  it("没有前台调用在跑时,registry.convertAll() 不影响正常路径", async () => {
    const { fn } = fakeRunAgent("单任务结果");
    const registry = createForegroundRegistry();
    const taskManager = createTaskManager();
    const ctx = mkCtx({ runAgent: fn, taskManager, foregroundRegistry: registry });
    const out = await agentTool.handler({ task: "do x" } as any, ctx);
    expect(out).toBe("单任务结果");
    expect(registry.convertAll()).toBe(0); // 已经在正常收尾时反注册了
  });

});
