import { describe, it, expect } from "vitest";
import { z } from "zod";
import { apiToolsForMode } from "./tools_for_mode.js";
import { ToolRegistry } from "./registry.js";
import { defineTool } from "./types.js";

function reg() {
  const r = new ToolRegistry();
  r.register(defineTool({ name: "read_file", description: "", capability: "read", approval: "auto", schema: z.object({}), handler: async () => "" }));
  r.register(defineTool({ name: "write_file", description: "", capability: "write", approval: "required", schema: z.object({}), handler: async () => "" }));
  r.register(defineTool({ name: "exec_shell", description: "", capability: "exec", approval: "required", schema: z.object({}), handler: async () => "" }));
  return r;
}

describe("apiToolsForMode", () => {
  it("returns all tools in normal mode", () => {
    const names = apiToolsForMode(reg(), "normal").map((t) => t.function.name);
    expect(names).toEqual(["read_file", "write_file", "exec_shell"]);
  });

  it("drops write/exec tools in plan mode", () => {
    const names = apiToolsForMode(reg(), "plan").map((t) => t.function.name);
    expect(names).toEqual(["read_file"]);
  });
});
