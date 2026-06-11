import { describe, it, expect } from "vitest";
import { runSubagent, type SubagentDeps } from "./subagent.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ApprovalGate } from "../approval/types.js";
import type { TurnDeps } from "./loop.js";

const stubGate: ApprovalGate = { decide: () => "allow", requestBatch: async () => new Map() };

function baseDeps(overrides: Partial<SubagentDeps>): SubagentDeps {
  return {
    task: "do X",
    systemPrompt: "SUB SYS",
    model: "deepseek-v4-pro",
    mode: "normal",
    config: { baseUrl: "", apiKey: "" },
    registry: new ToolRegistry(),
    ctx: { workspaceRoot: "/tmp" },
    gate: stubGate,
    streamChat: (() => {}) as unknown as TurnDeps["streamChat"],
    executeToolCalls: async () => [],
    write: () => {},
    runTurn: async () => {},
    ...overrides,
  };
}

describe("runSubagent", () => {
  it("runs the task on a fresh session and returns the final assistant content", async () => {
    const written: string[] = [];
    const result = await runSubagent(
      baseDeps({
        write: (s) => written.push(s),
        runTurn: async (deps) => {
          expect(deps.session.messages.map((m) => m.role)).toEqual(["system", "user"]);
          deps.session.messages.push({ role: "assistant", content: "子代理结果" });
        },
      }),
    );
    expect(result).toBe("子代理结果");
    expect(written.join("")).toContain("子代理开始");
    expect(written.join("")).toContain("子代理完成");
  });

  it("increments subagentDepth in the sub-ctx passed to runTurn", async () => {
    let seenDepth: number | undefined;
    await runSubagent(
      baseDeps({
        ctx: { workspaceRoot: "/tmp", subagentDepth: 0 },
        runTurn: async (deps) => {
          seenDepth = deps.ctx.subagentDepth;
          deps.session.messages.push({ role: "assistant", content: "x" });
        },
      }),
    );
    expect(seenDepth).toBe(1);
  });

  it("inherits the given mode", async () => {
    let seenMode: string | undefined;
    await runSubagent(
      baseDeps({
        mode: "plan",
        runTurn: async (deps) => {
          seenMode = deps.session.mode;
          deps.session.messages.push({ role: "assistant", content: "x" });
        },
      }),
    );
    expect(seenMode).toBe("plan");
  });

  it("returns a placeholder when there is no assistant output", async () => {
    const result = await runSubagent(baseDeps({ runTurn: async () => {} }));
    expect(result).toContain("无最终输出");
  });
});
