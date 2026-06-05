import { describe, it, expect } from "vitest";
import { executeToolCalls } from "./execute.js";
import type { ToolCall } from "../client/types.js";
import type { ToolContext, ToolDispatcher } from "./types.js";

const ctx: ToolContext = { workspaceRoot: "/tmp" };

function call(id: string, name: string, args = "{}"): ToolCall {
  return { id, type: "function", function: { name, arguments: args } };
}

describe("executeToolCalls", () => {
  it("maps each tool call to a tool message keyed by tool_call_id", async () => {
    const dispatcher: ToolDispatcher = {
      dispatch: async (name) => `result:${name}`,
    };
    const out = await executeToolCalls([call("a", "read_file"), call("b", "list_dir")], dispatcher, ctx);
    expect(out).toEqual([
      { role: "tool", tool_call_id: "a", content: "result:read_file" },
      { role: "tool", tool_call_id: "b", content: "result:list_dir" },
    ]);
  });

  it("isolates a failing tool as an error message without rejecting the batch", async () => {
    const dispatcher: ToolDispatcher = {
      dispatch: async (name) => {
        if (name === "bad") throw new Error("boom");
        return "ok";
      },
    };
    const out = await executeToolCalls([call("a", "bad"), call("b", "good")], dispatcher, ctx);
    expect(out[0]).toEqual({ role: "tool", tool_call_id: "a", content: "Error: boom" });
    expect(out[1]).toEqual({ role: "tool", tool_call_id: "b", content: "ok" });
  });

  it("runs the tool calls concurrently (overlapping execution)", async () => {
    const order: string[] = [];
    const dispatcher: ToolDispatcher = {
      dispatch: async (name) => {
        order.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, 15));
        order.push(`end:${name}`);
        return name;
      },
    };
    await executeToolCalls([call("a", "A"), call("b", "B")], dispatcher, ctx);
    // 并发:B 在 A 结束前就已开始
    expect(order.indexOf("start:B")).toBeLessThan(order.indexOf("end:A"));
  });
});
