import { describe, it, expect } from "vitest";
import { agentTool } from "./agent.js";

describe("agent tool", () => {
  it("delegates the task to ctx.runSubagent and returns its result", async () => {
    let got = "";
    const out = await agentTool.handler(
      { task: "investigate the build" },
      { workspaceRoot: "/tmp", runSubagent: async ({ task }) => { got = task; return "RESULT"; } },
    );
    expect(got).toBe("investigate the build");
    expect(out).toBe("RESULT");
  });

  it("refuses recursion when subagentDepth >= 1", async () => {
    let called = false;
    const out = await agentTool.handler(
      { task: "x" },
      { workspaceRoot: "/tmp", subagentDepth: 1, runSubagent: async () => { called = true; return "nope"; } },
    );
    expect(out).toContain("递归");
    expect(called).toBe(false);
  });

  it("errors when runSubagent is not configured", async () => {
    const out = await agentTool.handler({ task: "x" }, { workspaceRoot: "/tmp" });
    expect(out).toContain("不支持");
  });

  it("declares plan capability and auto approval", () => {
    expect(agentTool.capability).toBe("plan");
    expect(agentTool.approval).toBe("auto");
    expect(agentTool.name).toBe("agent");
  });

  it("tasks 数组 → 并行派发并汇总", async () => {
    const out = await agentTool.handler(
      { tasks: ["A", "B", "C"] },
      { workspaceRoot: "/tmp", runSubagent: async ({ task }) => `R:${task}` },
    );
    expect(out).toContain("子代理 1/3");
    expect(out).toContain("R:A");
    expect(out).toContain("R:B");
    expect(out).toContain("R:C");
  });

  it("agent_type 未知 → 提示可用类型", async () => {
    const out = await agentTool.handler(
      { task: "x", agent_type: "nope" },
      { workspaceRoot: "/tmp", runSubagent: async () => "r", agentTypes: [{ name: "reviewer", description: "审查" }] },
    );
    expect(out).toContain("未知子代理类型");
    expect(out).toContain("reviewer");
  });

  it("agent_type 有效 → 透传给 runSubagent", async () => {
    let passed: string | undefined;
    const out = await agentTool.handler(
      { task: "x", agent_type: "reviewer" },
      {
        workspaceRoot: "/tmp",
        runSubagent: async ({ agentType }) => { passed = agentType; return "审查结果"; },
        agentTypes: [{ name: "reviewer", description: "审查" }],
      },
    );
    expect(passed).toBe("reviewer");
    expect(out).toBe("审查结果");
  });

  it("单前台子代理超时 → 自动转后台", async () => {
    const prev = process.env.DAO_AUTO_BACKGROUND_MS;
    process.env.DAO_AUTO_BACKGROUND_MS = "10";
    let adopted = false;
    const out = await agentTool.handler(
      { task: "慢任务" },
      {
        workspaceRoot: "/tmp",
        runSubagent: () => new Promise<string>(() => {}), // 永不完成
        adoptBackground: () => { adopted = true; return "task-9"; },
      },
    );
    process.env.DAO_AUTO_BACKGROUND_MS = prev;
    expect(adopted).toBe(true);
    expect(out).toContain("自动转入后台");
    expect(out).toContain("task-9");
  });

  it("background → 后台启动返回 id,不阻塞", async () => {
    const launched: string[] = [];
    const out = await agentTool.handler(
      { task: "耗时调查", background: true },
      { workspaceRoot: "/tmp", runSubagent: async () => "x", runBackgroundAgent: (t) => { launched.push(t); return "task-1"; } },
    );
    expect(out).toContain("后台启动");
    expect(out).toContain("task-1");
    expect(launched).toEqual(["耗时调查"]);
  });

  it("并发限流:>10 个任务最多 10 个同时跑,其余排队,全部完成", async () => {
    let active = 0, maxActive = 0;
    const tasks = Array.from({ length: 15 }, (_, i) => `t${i}`);
    const out = await agentTool.handler(
      { tasks },
      {
        workspaceRoot: "/tmp",
        runSubagent: async ({ task }) => {
          active++; maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 10));
          active--; return `R:${task}`;
        },
      },
    );
    expect(maxActive).toBeLessThanOrEqual(10); // 限流生效
    expect(maxActive).toBeGreaterThan(1); // 确实并行
    expect(out).toContain("子代理 15/15"); // 全部完成
    expect(out).toContain("R:t14");
  });

  it("并行中单个失败不影响其余", async () => {
    const out = await agentTool.handler(
      { tasks: ["ok", "bad"] },
      { workspaceRoot: "/tmp", runSubagent: async ({ task }) => { if (task === "bad") throw new Error("炸了"); return `R:${task}`; } },
    );
    expect(out).toContain("R:ok");
    expect(out).toContain("[失败] 炸了");
  });
});

// 最小 ctx:记录 runSubagent 收到的 opts。
function mkCtx(over: Record<string, unknown> = {}) {
  const calls: any[] = [];
  return {
    calls,
    ctx: {
      workspaceRoot: "/tmp",
      readFiles: new Set<string>(),
      subagentDepth: 0,
      agentTypes: [{ name: "explore", description: "" }],
      runSubagent: async (opts: any) => { calls.push(opts); return "OK"; },
      ...over,
    } as any,
  };
}

describe("agent 工具 model/mode/fork 护栏", () => {
  it("model/mode 透传进 runSubagent opts", async () => {
    const { ctx, calls } = mkCtx();
    await agentTool.handler({ task: "do x", model: "deepseek-v4-flash", mode: "plan" } as any, ctx);
    expect(calls[0]).toMatchObject({ model: "deepseek-v4-flash", mode: "plan" });
  });
  it("fork + model → 拒绝(跨模型丢缓存)", async () => {
    const { ctx, calls } = mkCtx({ runForkAgent: async () => "F" });
    const r = await agentTool.handler({ task: "x", fork: true, model: "deepseek-v4-flash" } as any, ctx);
    expect(r).toContain("fork");
    expect(calls).toHaveLength(0); // 没真派
  });
  it("fork + mode → 拒绝", async () => {
    const { ctx } = mkCtx({ runForkAgent: async () => "F" });
    const r = await agentTool.handler({ task: "x", fork: true, mode: "plan" } as any, ctx);
    expect(r).toContain("fork");
  });
});
