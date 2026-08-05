import { describe, it, expect } from "vitest";
import { z } from "zod";
import { executeToolCalls } from "./execute.js";
import { ToolRegistry } from "./registry.js";
import { defineTool } from "./types.js";
import type { ToolCall } from "../client/types.js";
import type { ApprovalGate, ApprovalRequest, GateDecision } from "../approval/types.js";
import type { Tool } from "./types.js";

const ctx = { workspaceRoot: "/tmp" };

function call(id: string, name: string, args = "{}"): ToolCall {
  return { id, type: "function", function: { name, arguments: args } };
}

function reg() {
  const r = new ToolRegistry();
  r.register(
    defineTool({
      name: "Read", description: "", capability: "read", approval: "auto",
      schema: z.object({}), handler: async () => "READ",
    }),
  );
  r.register(
    defineTool({
      name: "Write", description: "", capability: "write", approval: "required",
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
    decideAsync: (_name: string, _args: string, tool: Tool) => Promise.resolve(tool.approval === "auto" ? "allow" : "ask"),
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
    decideAsync: async () => "deny",
    requestBatch: async (requests) => { calls.push(requests); return new Map(); },
  };
  return { gate, calls };
}

describe("executeToolCalls (approval-aware)", () => {
  it("runs auto tools without asking for approval", async () => {
    const { gate, calls } = gateWith(false);
    const out = await executeToolCalls([call("a", "Read")], reg(), ctx, gate);
    expect(out).toEqual([{ role: "tool", tool_call_id: "a", content: "READ" }]);
    expect(calls).toHaveLength(0);
  });

  it("executes a gated tool once approved", async () => {
    const { gate, calls } = gateWith(true);
    const out = await executeToolCalls([call("a", "Write")], reg(), ctx, gate);
    expect(out).toEqual([{ role: "tool", tool_call_id: "a", content: "WROTE" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]!.toolName).toBe("Write");
  });

  it("returns a rejection message when a gated tool is denied", async () => {
    const { gate } = gateWith(false);
    const out = await executeToolCalls([call("a", "Write")], reg(), ctx, gate);
    expect(out[0]!.content).toContain("用户拒绝");
  });

  it("asks approval for gated tools in a single batch and keeps order", async () => {
    const { gate, calls } = gateWith(true);
    const out = await executeToolCalls(
      [call("a", "Read"), call("b", "Write"), call("c", "Write")],
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
    const out = await executeToolCalls([call("a", "Write")], reg(), ctx, gate);
    expect(out[0]!.content).toContain("权限规则拒绝");
    expect(calls).toHaveLength(0); // deny 不进入审批询问
  });

  it("perm-trace 里 ask-approved 的 source 跟着 gate.lastApprovalSource 走(分类器/人工分开记)", async () => {
    const recorded: { tool: string; decision: string; source: string }[] = [];
    const auditCtx = { ...ctx, permAudit: { decided: (tool: string, _cap: string, decision: string, source: string) => { recorded.push({ tool, decision, source }); } } };
    const gate: ApprovalGate = {
      decide: (_n, _a, tool: Tool) => (tool.approval === "auto" ? "allow" : "ask"),
      decideAsync: async (_n, _a, tool: Tool) => (tool.approval === "auto" ? "allow" : "ask"),
      requestBatch: async (requests) => new Map(requests.map((r) => [r.id, true])),
      lastApprovalSource: (id) => (id === "byClassifier" ? "classifier" : "human"),
    };
    await executeToolCalls(
      [call("byClassifier", "Write"), call("byHuman", "Write")],
      reg(),
      auditCtx,
      gate,
    );
    expect(recorded).toContainEqual({ tool: "Write", decision: "ask-approved", source: "classifier" });
    expect(recorded).toContainEqual({ tool: "Write", decision: "ask-approved", source: "human" });
  });

  it("gate 没实现 lastApprovalSource(如旧假 gate)时,默认按 human 记,不能默认成 classifier", async () => {
    const recorded: { decision: string; source: string }[] = [];
    const auditCtx = { ...ctx, permAudit: { decided: (_t: string, _c: string, decision: string, source: string) => { recorded.push({ decision, source }); } } };
    const { gate } = gateWith(true); // gateWith 造的假 gate 没实现 lastApprovalSource
    await executeToolCalls([call("a", "Write")], reg(), auditCtx, gate);
    expect(recorded).toEqual([{ decision: "ask-approved", source: "human" }]);
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
    const allowGate: ApprovalGate = { decide: () => "allow", decideAsync: async () => "allow", requestBatch: async () => new Map() };
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
        name: "Read", description: "", capability: "read", approval: "auto",
        schema: z.object({}), handler: async () => { throw new Error("boom"); },
      }),
    );
    const { gate } = gateWith(false);
    const out = await executeToolCalls([call("a", "Read")], r, ctx, gate);
    expect(out[0]!.content).toBe("Error: boom");
  });
});

import { describeCall } from "./execute.js";
import { setLang } from "../i18n/i18n.js";
describe("③ exec 错误级联", () => {
  it("本批前一个 exec 失败 → 跳过后续 exec(防 install 挂了还跑 build)", async () => {
    const r = new ToolRegistry();
    let secondRan = false;
    r.register(defineTool({
      name: "Bash", description: "", capability: "exec", approval: "auto",
      schema: z.object({ n: z.number().optional() }),
      handler: async (a: { n?: number }) => { if (a.n === 2) { secondRan = true; return "ok2 [exit 0]"; } return "boom\n[exit 1]"; },
    }));
    const { gate } = gateWith(true);
    const out = await executeToolCalls(
      [call("a", "Bash", '{"n":1}'), call("b", "Bash", '{"n":2}')],
      r, ctx, gate,
    );
    expect(out.find((m) => m.tool_call_id === "a")!.content).toContain("[exit 1]");
    expect(out.find((m) => m.tool_call_id === "b")!.content).toContain("已跳过");
    expect(secondRan).toBe(false); // 第二个 exec 没执行
  });
});

// PreToolUse 钩子的最后一公里裁决 + updatedInput 改写(每工具只跑一次 hook)。
describe("executeToolCalls + PreToolUse hook", () => {
  // 跑工具的简单门:Read=auto→allow,Bash 按"是否含 rm -rf"动态裁决(用于 updatedInput 再裁决)。
  const reGate: ApprovalGate = {
    decide: (_name, args, tool) => {
      if (tool.approval === "auto") {
        if (/rm -rf/.test(args)) return "deny"; // 改写出危险命令 → 即便原本 auto 也拦
        return "allow";
      }
      return "ask";
    },
    decideAsync: (_name, args, tool) => Promise.resolve(((): GateDecision => {
      if (tool.approval === "auto") {
        if (/rm -rf/.test(args)) return "deny";
        return "allow";
      }
      return "ask";
    })()),
    requestBatch: async (requests) => new Map(requests.map((r) => [r.id, true])), // ask 一律批准(便于测 ask 路径)
  };
  const execReg = () => {
    const r = new ToolRegistry();
    let lastArgs = "";
    r.register(defineTool({
      name: "Bash", description: "", capability: "exec", approval: "auto",
      schema: z.object({ command: z.string() }),
      handler: async (a: { command: string }) => { lastArgs = a.command; return `RAN ${a.command}`; },
    }));
    return { r, getLastArgs: () => lastArgs };
  };

  it("block → 直接拒绝(强于规则 allow,不执行)", async () => {
    const { r } = execReg();
    const c = { ...ctx, preToolHook: async () => ({ block: true, reason: "nope" }) };
    const out = await executeToolCalls([call("a", "Bash", '{"command":"ls"}')], r, c, reGate);
    expect(out[0]!.content).toContain("被 hook 阻止");
    expect(out[0]!.content).toContain("nope");
  });

  it("permissionDecision deny → 拒绝(覆盖规则 allow)", async () => {
    const { r, getLastArgs } = execReg();
    const c = { ...ctx, preToolHook: async () => ({ block: false, reason: "", permissionDecision: "deny" as const }) };
    const out = await executeToolCalls([call("a", "Bash", '{"command":"ls"}')], r, c, reGate);
    expect(out[0]!.content).toContain("hook");
    expect(getLastArgs()).toBe(""); // 没执行
  });

  it("permissionDecision ask → 强制人工审批(原本 allow 也转 ask)", async () => {
    const r = new ToolRegistry();
    const seen: ApprovalRequest[][] = [];
    r.register(defineTool({ name: "Read", description: "", capability: "read", approval: "auto", schema: z.object({}), handler: async () => "READ" }));
    const gate: ApprovalGate = { decide: () => "allow", decideAsync: async () => "allow", requestBatch: async (reqs) => { seen.push(reqs); return new Map(reqs.map((q) => [q.id, true])); } };
    const c = { ...ctx, preToolHook: async () => ({ block: false, reason: "", permissionDecision: "ask" as const }) };
    const out = await executeToolCalls([call("a", "Read")], r, c, gate);
    expect(seen).toHaveLength(1); // 进了审批(原本 allow 不会进)
    expect(out[0]!.content).toBe("READ");
  });

  it("permissionDecision allow → 非敏感时把 ask 降为放行", async () => {
    const r = new ToolRegistry();
    let asked = false;
    r.register(defineTool({ name: "Read", description: "", capability: "read", approval: "required", schema: z.object({}), handler: async () => "READ" }));
    const gate: ApprovalGate = { decide: () => "ask", decideAsync: async () => "ask", requestBatch: async (reqs) => { asked = true; return new Map(reqs.map((q) => [q.id, false])); } };
    const c = { ...ctx, preToolHook: async () => ({ block: false, reason: "", permissionDecision: "allow" as const }) };
    const out = await executeToolCalls([call("a", "Read")], r, c, gate);
    expect(asked).toBe(false); // ask 被降为放行,没进审批
    expect(out[0]!.content).toBe("READ");
  });

  it("permissionDecision allow 不能覆盖规则 deny", async () => {
    const r = new ToolRegistry();
    r.register(defineTool({ name: "Write", description: "", capability: "write", approval: "required", schema: z.object({}), handler: async () => "WROTE" }));
    const gate: ApprovalGate = { decide: () => "deny", decideAsync: async () => "deny", requestBatch: async () => new Map() };
    const c = { ...ctx, preToolHook: async () => ({ block: false, reason: "", permissionDecision: "allow" as const }) };
    const out = await executeToolCalls([call("a", "Write")], r, c, gate);
    expect(out[0]!.content).toContain("权限规则拒绝"); // 规则 deny 不被 hook allow 覆盖
  });

  it("allow 不把危险/敏感的 ask 降级(rm -rf 仍走审批)", async () => {
    const r = new ToolRegistry();
    let asked = false;
    r.register(defineTool({ name: "Bash", description: "", capability: "exec", approval: "required", schema: z.object({ command: z.string() }), handler: async () => "RAN" }));
    const gate: ApprovalGate = { decide: () => "ask", decideAsync: async () => "ask", requestBatch: async (reqs) => { asked = true; return new Map(reqs.map((q) => [q.id, false])); } };
    const c = { ...ctx, preToolHook: async () => ({ block: false, reason: "", permissionDecision: "allow" as const }) };
    const out = await executeToolCalls([call("a", "Bash", '{"command":"rm -rf /"}')], r, c, gate);
    expect(asked).toBe(true); // 危险命令:allow 不降级,仍走审批
    expect(out[0]!.content).toContain("用户拒绝");
  });

  it("hook 每工具只跑一次(裁决 + 派发共用同一次)", async () => {
    const { r } = execReg();
    let n = 0;
    const c = { ...ctx, preToolHook: async () => { n++; return { block: false, reason: "" }; } };
    await executeToolCalls([call("a", "Bash", '{"command":"ls"}')], r, c, reGate);
    expect(n).toBe(1);
  });

  it("updatedInput 改写后【按改写参再裁决】(把 benign 改成 rm -rf 仍被门拦)", async () => {
    const { r, getLastArgs } = execReg();
    const c = { ...ctx, preToolHook: async () => ({ block: false, reason: "", updatedInput: { command: "rm -rf /" } }) };
    // 原始 args 是 ls(reGate 会 allow);hook 改写成 rm -rf → 门按改写参裁决为 deny。
    const out = await executeToolCalls([call("a", "Bash", '{"command":"ls"}')], r, c, reGate);
    expect(out[0]!.content).toContain("权限规则拒绝"); // 按改写参被门拦,没绕过
    expect(getLastArgs()).toBe(""); // 没执行
  });

  it("updatedInput 串进 dispatch / additionalContext 附到结果", async () => {
    const { r, getLastArgs } = execReg();
    const c = { ...ctx, preToolHook: async () => ({ block: false, reason: "", updatedInput: { command: "echo hi" }, additionalContext: "提示语" }) };
    const out = await executeToolCalls([call("a", "Bash", '{"command":"ls"}')], r, c, reGate);
    expect(getLastArgs()).toBe("echo hi"); // 派发用的是改写参
    expect(out[0]!.content).toContain("RAN echo hi");
    expect(out[0]!.content).toContain("[hook 提示] 提示语");
  });

  it("updatedInput 串进 postToolHook(用改写后的参)", async () => {
    const { r } = execReg();
    let postArgs = "";
    const c = {
      ...ctx,
      preToolHook: async () => ({ block: false, reason: "", updatedInput: { command: "echo hi" } }),
      postToolHook: async (_n: string, args: string) => { postArgs = args; },
    };
    await executeToolCalls([call("a", "Bash", '{"command":"ls"}')], r, c, reGate);
    expect(JSON.parse(postArgs)).toEqual({ command: "echo hi" });
  });
});

describe("headless 会话:第一步必须先用 TodoWrite(硬拦截,不是提醒)", () => {
  function regWithTodoWrite() {
    const r = reg(); // 已含 Read(auto)/Write(required)
    r.register(
      defineTool({
        name: "TodoWrite", description: "", capability: "plan", approval: "auto",
        schema: z.object({}), handler: async () => "TODO_OK",
      }),
    );
    return r;
  }

  it("headless + 首批无 TodoWrite → 整批拒绝执行,一个都不派发", async () => {
    const { gate } = gateWith(true);
    const hctx = { ...ctx, headless: true, todoWriteRequired: { done: false } };
    const out = await executeToolCalls([call("a", "Read")], regWithTodoWrite(), hctx, gate);
    expect(out[0]!.content).toContain("[操作被拒绝]");
    expect(out[0]!.content).toContain("TodoWrite");
    expect(hctx.todoWriteRequired.done).toBe(false); // 仍未满足,状态不变
  });

  it("headless + 首批含 TodoWrite(与其它工具混发)→ 全部放行执行", async () => {
    const { gate } = gateWith(true);
    const hctx = { ...ctx, headless: true, todoWriteRequired: { done: false } };
    const out = await executeToolCalls(
      [call("a", "TodoWrite"), call("b", "Read")],
      regWithTodoWrite(),
      hctx,
      gate,
    );
    expect(out.find((m) => m.tool_call_id === "a")!.content).toBe("TODO_OK");
    expect(out.find((m) => m.tool_call_id === "b")!.content).toBe("READ");
    expect(hctx.todoWriteRequired.done).toBe(true);
  });

  it("TodoWrite 已调用过(done=true)→ 后续轮次不再拦截", async () => {
    const { gate } = gateWith(true);
    const hctx = { ...ctx, headless: true, todoWriteRequired: { done: true } };
    const out = await executeToolCalls([call("a", "Read")], regWithTodoWrite(), hctx, gate);
    expect(out[0]!.content).toBe("READ");
  });

  it("非 headless(ctx.headless 为空,如交互式/子代理场景)→ 不受影响,即便 todoWriteRequired 存在", async () => {
    const { gate } = gateWith(true);
    const ictx = { ...ctx, todoWriteRequired: { done: false } }; // headless 未设置
    const out = await executeToolCalls([call("a", "Read")], regWithTodoWrite(), ictx, gate);
    expect(out[0]!.content).toBe("READ");
  });

  it("headless=true 但 ctx.todoWriteRequired 未注入 → 优雅跳过,不报错", async () => {
    const { gate } = gateWith(true);
    const hctx = { ...ctx, headless: true }; // 未注入 todoWriteRequired
    const out = await executeToolCalls([call("a", "Read")], regWithTodoWrite(), hctx, gate);
    expect(out[0]!.content).toBe("READ");
  });
});

describe("describeCall", () => {
  it("Bash → $ 命令(保留真实换行,不是字面 \\n)", () => {
    const out = describeCall("Bash", JSON.stringify({ command: "cat > f << EOF\nhi\nEOF" }));
    expect(out.startsWith("$ ")).toBe(true);
    expect(out).toContain("\n"); // 真实换行
    expect(out).not.toContain("\\n"); // 不是字面反斜杠 n
  });
  it("write/edit → 中文模式下只显路径", () => {
    setLang("zh");
    expect(describeCall("Write", '{"path":"a.txt","content":"..."}')).toBe("写入 a.txt");
    expect(describeCall("Edit", '{"path":"b.ts"}')).toBe("编辑 b.ts");
  });
  it("write/edit → 英文模式下只显路径", () => {
    setLang("en");
    expect(describeCall("Write", '{"path":"a.txt","content":"..."}')).toBe("Write a.txt");
    expect(describeCall("Edit", '{"path":"b.ts"}')).toBe("Edit b.ts");
  });
});
