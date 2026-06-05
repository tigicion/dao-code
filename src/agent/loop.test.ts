import { describe, it, expect } from "vitest";
import { runAgent } from "./loop.js";
import { ToolRegistry } from "../tools/registry.js";
import type { AssistantMessage, StreamDelta, ToolMessage } from "../client/types.js";
import type { ApprovalGate } from "../approval/types.js";

const stubGate: ApprovalGate = { needsApproval: () => false, requestBatch: async () => new Map() };
const config = { baseUrl: "https://x", apiKey: "sk", model: "deepseek-v4-pro" };
const ctx = { workspaceRoot: "/tmp" };

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

describe("runAgent", () => {
  it("returns after one turn when the model requests no tools", async () => {
    const written: string[] = [];
    const messages = await runAgent({
      prompt: "hi",
      config,
      registry: new ToolRegistry(),
      ctx,
      gate: stubGate,
      streamChat: scripted([
        turn([{ kind: "content", text: "hello" }], { role: "assistant", content: "hello" }),
      ]),
      executeToolCalls: async () => [],
      write: (s) => written.push(s),
    });
    expect(messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(written.join("")).toContain("hello");
  });

  it("executes tools then loops until the model stops requesting them", async () => {
    const assistantWithTool: AssistantMessage = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c0", type: "function", function: { name: "read_file", arguments: "{}" } }],
    };
    const toolResult: ToolMessage[] = [{ role: "tool", tool_call_id: "c0", content: "FILE BODY" }];
    const messages = await runAgent({
      prompt: "read a",
      config,
      registry: new ToolRegistry(),
      ctx,
      gate: stubGate,
      streamChat: scripted([
        turn([{ kind: "tool_call", index: 0, name: "read_file" }], assistantWithTool),
        turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" }),
      ]),
      executeToolCalls: async () => toolResult,
      write: () => {},
    });
    expect(messages).toEqual([
      { role: "user", content: "read a" },
      assistantWithTool,
      { role: "tool", tool_call_id: "c0", content: "FILE BODY" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("prepends a system message when provided", async () => {
    const messages = await runAgent({
      prompt: "hi",
      system: "you are codeds",
      config,
      registry: new ToolRegistry(),
      ctx,
      gate: stubGate,
      streamChat: scripted([turn([], { role: "assistant", content: "ok" })]),
      executeToolCalls: async () => [],
      write: () => {},
    });
    expect(messages[0]).toEqual({ role: "system", content: "you are codeds" });
  });

  it("stops at maxTurns when the model keeps requesting tools", async () => {
    const written: string[] = [];
    const looping = () =>
      turn([], {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c", type: "function", function: { name: "read_file", arguments: "{}" } }],
      })();
    const messages = await runAgent({
      prompt: "loop",
      config,
      registry: new ToolRegistry(),
      ctx,
      gate: stubGate,
      streamChat: scripted([looping, looping, looping, looping, looping]),
      executeToolCalls: async () => [{ role: "tool", tool_call_id: "c", content: "x" }],
      write: (s) => written.push(s),
      maxTurns: 3,
    });
    expect(messages).toHaveLength(7);
    expect(written.join("")).toContain("最大轮数");
  });

  it("omits tools and parallel_tool_calls when the registry is empty", async () => {
    let sentOpts: any;
    await runAgent({
      prompt: "hi",
      config,
      registry: new ToolRegistry(), // empty
      ctx,
      gate: stubGate,
      streamChat: (opts) => {
        sentOpts = opts;
        return turn([{ kind: "content", text: "ok" }], { role: "assistant", content: "ok" })();
      },
      executeToolCalls: async () => [],
      write: () => {},
    });
    expect(sentOpts.tools).toBeUndefined();
    expect(sentOpts.parallelToolCalls).toBeUndefined();
  });
});
