import { describe, it, expect } from "vitest";
import { agentTool } from "./agent.js";

describe("agent tool", () => {
  it("delegates the task to ctx.runSubagent and returns its result", async () => {
    let got = "";
    const out = await agentTool.handler(
      { task: "investigate the build" },
      { workspaceRoot: "/tmp", runSubagent: async (t) => { got = t; return "RESULT"; } },
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
      { workspaceRoot: "/tmp", runSubagent: async (t) => `R:${t}` },
    );
    expect(out).toContain("子代理 1/3");
    expect(out).toContain("R:A");
    expect(out).toContain("R:B");
    expect(out).toContain("R:C");
  });

  it("并行中单个失败不影响其余", async () => {
    const out = await agentTool.handler(
      { tasks: ["ok", "bad"] },
      { workspaceRoot: "/tmp", runSubagent: async (t) => { if (t === "bad") throw new Error("炸了"); return `R:${t}`; } },
    );
    expect(out).toContain("R:ok");
    expect(out).toContain("[失败] 炸了");
  });
});
