import { describe, it, expect } from "vitest";
import { z } from "zod";
import { apiToolsForMode } from "./tools_for_mode.js";
import { ToolRegistry } from "./registry.js";
import { defineTool } from "./types.js";

function reg() {
  const r = new ToolRegistry();
  r.register(defineTool({ name: "Read", description: "", capability: "read", approval: "auto", schema: z.object({}), handler: async () => "" }));
  r.register(defineTool({ name: "Write", description: "", capability: "write", approval: "required", schema: z.object({}), handler: async () => "" }));
  r.register(defineTool({ name: "Bash", description: "", capability: "exec", approval: "required", schema: z.object({}), handler: async () => "" }));
  return r;
}

describe("apiToolsForMode", () => {
  it("returns all tools in normal mode", () => {
    const names = apiToolsForMode(reg(), "normal").map((t) => t.function.name);
    expect(names).toEqual(["Read", "Write", "Bash"]);
  });

  it("drops write/exec tools in plan mode", () => {
    const names = apiToolsForMode(reg(), "plan").map((t) => t.function.name);
    expect(names).toEqual(["Read"]);
  });

  it("mcp__ 工具默认不出现,ToolSearch 命中激活后才出现(normal/plan 均生效)", () => {
    const r = reg();
    r.register(defineTool({ name: "mcp__github__create_issue", description: "建 issue", capability: "network", approval: "suggest", schema: z.object({}), handler: async () => "" }));
    expect(apiToolsForMode(r, "normal").map((t) => t.function.name)).not.toContain("mcp__github__create_issue");
    r.searchAndActivateMcp("issue");
    expect(apiToolsForMode(r, "normal").map((t) => t.function.name)).toContain("mcp__github__create_issue");
  });
});
