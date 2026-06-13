import { describe, it, expect } from "vitest";
import { runTurn } from "./loop.js";
import { Session } from "../session/session.js";
import { ToolRegistry } from "../tools/registry.js";
import { defineTool } from "../tools/types.js";
import { z } from "zod";
import type { AssistantMessage, StreamChatOptions, StreamDelta, ToolMessage } from "../client/types.js";
import type { ApprovalGate } from "../approval/types.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCacheAuditSink } from "../session/cache_audit.js";

const config = { baseUrl: "https://x", apiKey: "sk" };
const ctx = { workspaceRoot: "/tmp" };
const stubGate: ApprovalGate = { decide: () => "allow", requestBatch: async () => new Map() };

function turn(deltas: StreamDelta[], message: AssistantMessage) {
  return async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
    for (const d of deltas) yield d;
    return message;
  };
}
function scripted(turns: Array<() => AsyncGenerator<StreamDelta, AssistantMessage>>) {
  let i = 0;
  return () => turns[i++]!();
}
function emptyReg() {
  return new ToolRegistry();
}

describe("runTurn", () => {
  it("appends the assistant reply to the session when no tools requested", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    await runTurn({
      session: s,
      config,
      registry: emptyReg(),
      ctx,
      gate: stubGate,
      streamChat: scripted([turn([{ kind: "content", text: "hello" }], { role: "assistant", content: "hello" })]),
      executeToolCalls: async () => [],
      write: () => {},
    });
    expect(s.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("空 assistant(无内容无工具)不入库,防下一轮 DeepSeek 400", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    await runTurn({
      session: s,
      config,
      registry: emptyReg(),
      ctx,
      gate: stubGate,
      streamChat: scripted([turn([], { role: "assistant", content: "" })]),
      executeToolCalls: async () => [],
      write: () => {},
    });
    expect(s.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
    ]); // 空 assistant 被丢弃,不入库
  });

  it("sends session.model and runs tools then loops", async () => {
    const s = new Session("SYS", "deepseek-v4-flash");
    s.addUser("go");
    let sentModel = "";
    const assistantWithTool: AssistantMessage = {
      role: "assistant", content: null,
      tool_calls: [{ id: "c0", type: "function", function: { name: "read_file", arguments: "{}" } }],
    };
    const toolMsgs: ToolMessage[] = [{ role: "tool", tool_call_id: "c0", content: "R" }];
    const calls = scripted([
      turn([], assistantWithTool),
      turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" }),
    ]);
    await runTurn({
      session: s,
      config,
      registry: emptyReg(),
      ctx,
      gate: stubGate,
      streamChat: ((opts: StreamChatOptions) => {
        sentModel = opts.model;
        return calls();
      }) as any,
      executeToolCalls: async () => toolMsgs,
      write: () => {},
    });
    expect(sentModel).toBe("deepseek-v4-flash");
    expect(s.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
  });

  it("条件技能:工具执行后据被操作文件激活,正文注入 session;写 pivot 刷新 transient", async () => {
    const s = new Session("SYS", "m");
    s.addUser("改下组件");
    const editCall: AssistantMessage = {
      role: "assistant", content: "我来改这个组件",
      tool_calls: [{ id: "c0", type: "function", function: { name: "edit_file", arguments: JSON.stringify({ path: "src/Button.tsx" }) } }],
    };
    let rediscoverQuery = "";
    const sentTails: (string | undefined)[] = [];
    await runTurn({
      session: s,
      config,
      registry: emptyReg(),
      ctx,
      gate: stubGate,
      transientSystem: "[初始发现]",
      streamChat: ((opts: StreamChatOptions) => {
        const tail = opts.messages[opts.messages.length - 1];
        sentTails.push(tail?.role === "system" ? String(tail.content) : undefined);
        return (s.messages.length > 4
          ? turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" })
          : turn([], editCall))();
      }) as any,
      executeToolCalls: async () => [{ role: "tool", tool_call_id: "c0", content: "ok" }],
      write: () => {},
      activateSkillsForPaths: (calls) =>
        calls.some((c) => c.function.arguments.includes(".tsx")) ? "[激活] tsx 约定正文" : undefined,
      rediscoverAfterWrite: (_calls, content) => { rediscoverQuery = content; return "[pivot 后发现]"; },
    });
    // 激活正文作为 system 消息一次性写入 session
    expect(s.messages.some((m) => m.role === "system" && String(m.content).includes("tsx 约定正文"))).toBe(true);
    // 写 pivot 用 assistant 意图重算发现
    expect(rediscoverQuery).toBe("我来改这个组件");
    // 第一次调用发的是初始发现;pivot 之后那次发的是刷新后的发现
    expect(sentTails[0]).toBe("[初始发现]");
    expect(sentTails[1]).toBe("[pivot 后发现]");
  });

  it("omits write/exec tools in plan mode", async () => {
    const r = new ToolRegistry();
    r.register(defineTool({ name: "read_file", description: "", capability: "read", approval: "auto", schema: z.object({}), handler: async () => "" }));
    r.register(defineTool({ name: "write_file", description: "", capability: "write", approval: "required", schema: z.object({}), handler: async () => "" }));
    const s = new Session("SYS", "m");
    s.addUser("plan something");
    s.toggleMode();
    let sentTools: string[] | undefined;
    await runTurn({
      session: s,
      config,
      registry: r,
      ctx,
      gate: stubGate,
      streamChat: ((opts: StreamChatOptions) => {
        sentTools = opts.tools?.map((t) => t.function.name);
        return turn([{ kind: "content", text: "ok" }], { role: "assistant", content: "ok" })();
      }) as any,
      executeToolCalls: async () => [],
      write: () => {},
    });
    expect(sentTools).toEqual(["read_file"]);
  });

  it("stops at maxTurns", async () => {
    const s = new Session("SYS", "m");
    s.addUser("loop");
    const looping = () => turn([], { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "x", arguments: "{}" } }] })();
    const written: string[] = [];
    await runTurn({
      session: s,
      config,
      registry: emptyReg(),
      ctx,
      gate: stubGate,
      streamChat: scripted([looping, looping, looping, looping]),
      executeToolCalls: async () => [{ role: "tool", tool_call_id: "c", content: "x" }],
      write: (t) => written.push(t),
      maxTurns: 2,
    });
    expect(written.join("")).toContain("最大轮数");
  });

  it("forwards the signal to streamChat", async () => {
    const s = new Session("SYS", "m");
    s.addUser("hi");
    const controller = new AbortController();
    let sentSignal: AbortSignal | undefined;
    await runTurn({
      session: s,
      config,
      registry: emptyReg(),
      ctx,
      gate: stubGate,
      streamChat: ((opts: StreamChatOptions) => {
        sentSignal = opts.signal;
        return turn([{ kind: "content", text: "ok" }], { role: "assistant", content: "ok" })();
      }) as any,
      executeToolCalls: async () => [],
      write: () => {},
      signal: controller.signal,
    });
    expect(sentSignal).toBe(controller.signal);
  });

  it("aborted after assistant(tool_calls): 不执行工具,但补齐 tool 结果不留悬空(防下一轮 DeepSeek 400)", async () => {
    const s = new Session("SYS", "m");
    s.addUser("go");
    const controller = new AbortController();
    let executed = 0;
    // 模拟:模型答完(带 tool_calls)随即用户 abort —— 工具尚未执行。
    const partialWithTool: AssistantMessage = {
      role: "assistant", content: "partial",
      tool_calls: [{ id: "c0", type: "function", function: { name: "read_file", arguments: "{}" } }],
    };
    await runTurn({
      session: s,
      config,
      registry: emptyReg(),
      ctx,
      gate: stubGate,
      streamChat: (() =>
        (async function* () {
          controller.abort();
          return partialWithTool;
        })()) as any,
      executeToolCalls: (async (cs: any) => { executed += cs.length; return []; }) as any,
      write: () => {},
      signal: controller.signal,
    });
    expect(executed).toBe(0); // abort 后不执行工具
    expect(s.messages.at(-2)).toEqual(partialWithTool); // 部分回复已入库
    const last = s.messages.at(-1) as ToolMessage; // 紧跟一条取消用 tool 结果
    expect(last.role).toBe("tool");
    expect(last.tool_call_id).toBe("c0");
    // 不变式:每个 assistant 的 tool_call 都有对应 tool 结果,历史可合法再发给 API。
    const wanted = s.messages.filter((m) => m.role === "assistant").flatMap((m) => (m as AssistantMessage).tool_calls ?? []).map((tc) => tc.id);
    const answered = new Set(s.messages.filter((m) => m.role === "tool").map((m) => (m as ToolMessage).tool_call_id));
    expect(wanted.every((id) => answered.has(id))).toBe(true);
  });

  it("returns immediately without calling streamChat when already aborted", async () => {
    const s = new Session("SYS", "m");
    s.addUser("hi");
    const controller = new AbortController();
    controller.abort();
    let called = 0;
    await runTurn({
      session: s,
      config,
      registry: emptyReg(),
      ctx,
      gate: stubGate,
      streamChat: (() => { called++; return turn([], { role: "assistant", content: "x" })(); }) as any,
      executeToolCalls: async () => [],
      write: () => {},
      signal: controller.signal,
    });
    expect(called).toBe(0);
  });

  it("blocks write/exec tool calls at execution in plan mode (does not dispatch them)", async () => {
    const r = new ToolRegistry();
    r.register(defineTool({ name: "read_file", description: "", capability: "read", approval: "auto", schema: z.object({}), handler: async () => "" }));
    r.register(defineTool({ name: "write_file", description: "", capability: "write", approval: "required", schema: z.object({}), handler: async () => "" }));
    const s = new Session("SYS", "m");
    s.addUser("create a file");
    s.toggleMode(); // → plan
    let executedCalls = 0;
    const calls = scripted([
      turn([], { role: "assistant", content: null, tool_calls: [{ id: "w0", type: "function", function: { name: "write_file", arguments: "{}" } }] }),
      turn([{ kind: "content", text: "can't in plan" }], { role: "assistant", content: "can't in plan" }),
    ]);
    await runTurn({
      session: s,
      config,
      registry: r,
      ctx,
      gate: stubGate,
      streamChat: () => calls(),
      executeToolCalls: (async (cs: any) => { executedCalls += cs.length; return cs.map((c: any) => ({ role: "tool", tool_call_id: c.id, content: "RAN" })); }) as any,
      write: () => {},
    });
    expect(executedCalls).toBe(0); // write_file never dispatched in plan
    const toolMsg = s.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("不可用");
  });

  it("runTurn records a cache-audit event via the injected sink", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loop-ca-"));
    const sink = createCacheAuditSink(dir, {});
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    await runTurn({
      session: s,
      config,
      registry: emptyReg(),
      ctx,
      gate: stubGate,
      streamChat: ((opts: StreamChatOptions) => {
        opts.onUsage?.({ prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_cache_hit_tokens: 90, prompt_cache_miss_tokens: 10 });
        return turn([{ kind: "content", text: "hello" }], { role: "assistant", content: "hello" })();
      }) as any,
      executeToolCalls: async () => [],
      write: () => {},
      auditSink: sink,
      auditId: { agent: "main", depth: 0 },
    });
    const lines = readFileSync(path.join(dir, "cache.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(lines[0]!).agent).toBe("main");
  });
});
