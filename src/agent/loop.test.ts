import { describe, it, expect } from "vitest";
import { runTurn } from "./loop.js";
import { Session } from "../session/session.js";
import { ToolRegistry } from "../tools/registry.js";
import { defineTool } from "../tools/types.js";
import { z } from "zod";
import type { AssistantMessage, StreamChatOptions, StreamDelta, ToolMessage } from "../client/types.js";
import type { ApprovalGate } from "../approval/types.js";

const config = { baseUrl: "https://x", apiKey: "sk" };
const ctx = { workspaceRoot: "/tmp" };
const stubGate: ApprovalGate = { needsApproval: () => false, requestBatch: async () => new Map() };

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
});
