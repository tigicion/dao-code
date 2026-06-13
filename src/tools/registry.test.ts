import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "./registry.js";
import { defineTool } from "./types.js";

function makeEcho() {
  return defineTool({
    name: "echo",
    description: "echoes the text",
    capability: "read",
    approval: "auto",
    schema: z.object({ text: z.string() }),
    handler: async (args) => `echo:${args.text}`,
  });
}

describe("ToolRegistry", () => {
  it("registers and dispatches a tool with validated args", async () => {
    const reg = new ToolRegistry();
    reg.register(makeEcho());
    const out = await reg.dispatch("echo", '{"text":"hi"}', { workspaceRoot: "/tmp" });
    expect(out).toBe("echo:hi");
  });

  it("exposes API tools in registration order with name/description/parameters", () => {
    const reg = new ToolRegistry();
    reg.register(makeEcho());
    const api = reg.toApiTools();
    expect(api).toHaveLength(1);
    expect(api[0]!.type).toBe("function");
    expect(api[0]!.function.name).toBe("echo");
    expect(api[0]!.function.description).toBe("echoes the text");
    expect((api[0]!.function.parameters as any).type).toBe("object");
  });

  it("throws on unknown tool", async () => {
    const reg = new ToolRegistry();
    await expect(reg.dispatch("nope", "{}", { workspaceRoot: "/tmp" })).rejects.toThrow(/unknown tool: nope/);
  });

  it("throws on invalid JSON arguments", async () => {
    const reg = new ToolRegistry();
    reg.register(makeEcho());
    await expect(reg.dispatch("echo", "{not json", { workspaceRoot: "/tmp" })).rejects.toThrow(
      /invalid JSON arguments for echo/,
    );
  });

  it("throws when args fail schema validation", async () => {
    const reg = new ToolRegistry();
    reg.register(makeEcho());
    await expect(reg.dispatch("echo", '{"text":123}', { workspaceRoot: "/tmp" })).rejects.toThrow();
  });
});

const mk = (name: string) =>
  defineTool({ name, description: name, capability: "read", approval: "auto", schema: z.object({}), handler: async () => "" });

describe("ToolRegistry.subsetExcluding", () => {
  it("保留除排除名外的全部工具,维持插入顺序", () => {
    const r = new ToolRegistry();
    ["a", "b", "c", "d"].forEach((n) => r.register(mk(n)));
    const sub = r.subsetExcluding(new Set(["b", "d"]));
    expect(sub.get("a")).toBeDefined();
    expect(sub.get("c")).toBeDefined();
    expect(sub.get("b")).toBeUndefined();
    expect(sub.get("d")).toBeUndefined();
    expect(sub.toApiTools().map((t) => t.function.name)).toEqual(["a", "c"]);
  });
  it("排除空集 → 全保留", () => {
    const r = new ToolRegistry();
    ["a", "b"].forEach((n) => r.register(mk(n)));
    expect(r.subsetExcluding(new Set()).toApiTools()).toHaveLength(2);
  });
});
