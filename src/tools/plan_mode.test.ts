import { describe, it, expect } from "vitest";
import { enterPlanModeTool, exitPlanModeTool } from "./plan_mode.js";

describe("EnterPlanMode tool", () => {
  it("switches to plan mode in an interactive session", async () => {
    let mode = "normal";
    const out = await enterPlanModeTool.handler(
      {},
      { workspaceRoot: "/tmp", setMode: (m) => { mode = m; } },
    );
    expect(mode).toBe("plan");
    expect(out).toMatch(/规划模式/);
  });

  it("refuses to enter plan mode when headless (no one can approve the exit)", async () => {
    let mode = "normal";
    const out = await enterPlanModeTool.handler(
      {},
      { workspaceRoot: "/tmp", headless: true, setMode: (m) => { mode = m; } },
    );
    expect(mode).toBe("normal");
    expect(out).toMatch(/无人值守|headless|没有人能批准/);
  });

  it("reports unsupported when setMode is not configured", async () => {
    const out = await enterPlanModeTool.handler({}, { workspaceRoot: "/tmp" });
    expect(out).toMatch(/不支持模式切换/);
  });
});

describe("ExitPlanMode tool", () => {
  it("blocks on real user approval via ctx.askChoice when interactive", async () => {
    let mode = "plan";
    let asked = "";
    const out = await exitPlanModeTool.handler(
      {},
      {
        workspaceRoot: "/tmp",
        setMode: (m) => { mode = m; },
        askChoice: async (q) => { asked = q; return "批准,开始实现"; },
      },
    );
    expect(asked).toMatch(/批准/);
    expect(mode).toBe("normal");
    expect(out).toMatch(/已退出规划模式/);
  });

  it("stays in plan mode when the user rejects the plan", async () => {
    let mode = "plan";
    const out = await exitPlanModeTool.handler(
      {},
      {
        workspaceRoot: "/tmp",
        setMode: (m) => { mode = m; },
        askChoice: async () => "不批准,继续讨论",
      },
    );
    expect(mode).toBe("plan");
    expect(out).toMatch(/未批准/);
  });

  it("auto-approves without blocking when there is no askChoice channel (headless)", async () => {
    let mode = "plan";
    const out = await exitPlanModeTool.handler(
      { },
      { workspaceRoot: "/tmp", headless: true, setMode: (m) => { mode = m; } },
    );
    expect(mode).toBe("normal");
    expect(out).toMatch(/已退出规划模式/);
  });

  it("reports unsupported when setMode is not configured", async () => {
    const out = await exitPlanModeTool.handler({}, { workspaceRoot: "/tmp" });
    expect(out).toMatch(/不支持模式切换/);
  });
});
