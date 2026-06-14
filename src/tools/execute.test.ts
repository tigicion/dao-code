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

  it("按 capability 并发:read(安全)并行,write(屏障)串行", async () => {
    const timedReg = (capability: "read" | "write") => {
      let active = 0, maxActive = 0;
      const r = new ToolRegistry();
      r.register(defineTool({
        name: "t", description: "", capability, approval: "auto",
        schema: z.object({}),
        handler: async () => {
          active++; maxActive = Math.max(maxActive, active);
          await new Promise((res) => setTimeout(res, 15));
          active--; return "ok";
        },
      }));
      return { r, getMax: () => maxActive };
    };
    const allowGate: ApprovalGate = { decide: () => "allow", requestBatch: async () => new Map() };
    const calls = [call("a", "t"), call("b", "t"), call("c", "t")];

    const rd = timedReg("read");
    await executeToolCalls(calls, rd.r, ctx, allowGate);
    expect(rd.getMax()).toBeGreaterThan(1); // 只读 → 并行

    const wr = timedReg("write");
    await executeToolCalls(calls, wr.r, ctx, allowGate);
    expect(wr.getMax()).toBe(1); // 写 → 屏障,独占
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

import { describeCall } from "./execute.js";
describe("③ exec 错误级联", () => {
  it("本批前一个 exec 失败 → 跳过后续 exec(防 install 挂了还跑 build)", async () => {
    const r = new ToolRegistry();
    let secondRan = false;
    r.register(defineTool({
      name: "exec_shell", description: "", capability: "exec", approval: "auto",
      schema: z.object({ n: z.number().optional() }),
      handler: async (a: { n?: number }) => { if (a.n === 2) { secondRan = true; return "ok2 [exit 0]"; } return "boom\n[exit 1]"; },
    }));
    const { gate } = gateWith(true);
    const out = await executeToolCalls(
      [call("a", "exec_shell", '{"n":1}'), call("b", "exec_shell", '{"n":2}')],
      r, ctx, gate,
    );
    expect(out.find((m) => m.tool_call_id === "a")!.content).toContain("[exit 1]");
    expect(out.find((m) => m.tool_call_id === "b")!.content).toContain("已跳过");
    expect(secondRan).toBe(false); // 第二个 exec 没执行
  });
});

describe("describeCall", () => {
  it("exec_shell → $ 命令(保留真实换行,不是字面 \\n)", () => {
    const out = describeCall("exec_shell", JSON.stringify({ command: "cat > f << EOF\nhi\nEOF" }));
    expect(out.startsWith("$ ")).toBe(true);
    expect(out).toContain("\n"); // 真实换行
    expect(out).not.toContain("\\n"); // 不是字面反斜杠 n
  });
  it("write/edit → 只显路径", () => {
    expect(describeCall("write_file", '{"path":"a.txt","content":"..."}')).toBe("写入 a.txt");
    expect(describeCall("edit_file", '{"path":"b.ts"}')).toBe("编辑 b.ts");
  });
});
