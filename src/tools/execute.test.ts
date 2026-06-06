import { describe, it, expect } from "vitest";
import { z } from "zod";
import { executeToolCalls } from "./execute.js";
import { ToolRegistry } from "./registry.js";
import { defineTool } from "./types.js";
import type { ToolCall } from "../client/types.js";
import type { ApprovalGate, ApprovalRequest } from "../approval/types.js";
import type { Tool } from "./types.js";

const ctx = { workspaceRoot: "/tmp" };

function call(id: string, name: string, args = "{}"): ToolCall {
  return { id, type: "function", function: { name, arguments: args } };
}

function reg() {
  const r = new ToolRegistry();
  r.register(
    defineTool({
      name: "read_file", description: "", capability: "read", approval: "auto",
      schema: z.object({}), handler: async () => "READ",
    }),
  );
  r.register(
    defineTool({
      name: "write_file", description: "", capability: "write", approval: "required",
      schema: z.object({}), handler: async () => "WROTE",
    }),
  );
  return r;
}

function gateWith(approve: boolean) {
  const calls: ApprovalRequest[][] = [];
  const gate: ApprovalGate = {
    // auto 工具放行;其余进入 ask(审批)。
    decide: (_name: string, _args: string, tool: Tool) => (tool.approval === "auto" ? "allow" : "ask"),
    requestBatch: async (requests) => {
      calls.push(requests);
      return new Map(requests.map((r) => [r.id, approve]));
    },
  };
  return { gate, calls };
}

// deny 门:模拟 deny 规则命中(直接拦截,不询问)。
function denyGate() {
  const calls: ApprovalRequest[][] = [];
  const gate: ApprovalGate = {
    decide: () => "deny",
    requestBatch: async (requests) => { calls.push(requests); return new Map(); },
  };
  return { gate, calls };
}

describe("executeToolCalls (approval-aware)", () => {
  it("runs auto tools without asking for approval", async () => {
    const { gate, calls } = gateWith(false);
    const out = await executeToolCalls([call("a", "read_file")], reg(), ctx, gate);
    expect(out).toEqual([{ role: "tool", tool_call_id: "a", content: "READ" }]);
    expect(calls).toHaveLength(0);
  });

  it("executes a gated tool once approved", async () => {
    const { gate, calls } = gateWith(true);
    const out = await executeToolCalls([call("a", "write_file")], reg(), ctx, gate);
    expect(out).toEqual([{ role: "tool", tool_call_id: "a", content: "WROTE" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]!.toolName).toBe("write_file");
  });

  it("returns a rejection message when a gated tool is denied", async () => {
    const { gate } = gateWith(false);
    const out = await executeToolCalls([call("a", "write_file")], reg(), ctx, gate);
    expect(out[0]!.content).toContain("用户拒绝");
  });

  it("asks approval for gated tools in a single batch and keeps order", async () => {
    const { gate, calls } = gateWith(true);
    const out = await executeToolCalls(
      [call("a", "read_file"), call("b", "write_file"), call("c", "write_file")],
      reg(),
      ctx,
      gate,
    );
    expect(out.map((m) => m.tool_call_id)).toEqual(["a", "b", "c"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.map((r) => r.id)).toEqual(["b", "c"]);
  });

  it("blocks a denied tool without asking and returns a deny message", async () => {
    const { gate, calls } = denyGate();
    const out = await executeToolCalls([call("a", "write_file")], reg(), ctx, gate);
    expect(out[0]!.content).toContain("权限规则拒绝");
    expect(calls).toHaveLength(0); // deny 不进入审批询问
  });

  it("isolates a dispatch error as an Error message", async () => {
    const r = new ToolRegistry();
    r.register(
      defineTool({
        name: "read_file", description: "", capability: "read", approval: "auto",
        schema: z.object({}), handler: async () => { throw new Error("boom"); },
      }),
    );
    const { gate } = gateWith(false);
    const out = await executeToolCalls([call("a", "read_file")], r, ctx, gate);
    expect(out[0]!.content).toBe("Error: boom");
  });
});
