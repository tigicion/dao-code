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
});
