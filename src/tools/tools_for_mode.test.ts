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

  it("MCP 工具 ≤ 5 时自动内联(不需 ToolSearch 激活)", () => {
    const r = reg();
    r.register(defineTool({ name: "mcp__github__create_issue", description: "建 issue", capability: "network", approval: "suggest", schema: z.object({}), handler: async () => "" }));
    // 1 个 MCP 工具 ≤ 阈值 -> 直接内联
    expect(apiToolsForMode(r, "normal").map((t) => t.function.name)).toContain("mcp__github__create_issue");
  });

  it("MCP 工具 > 5 时默认不出现,ToolSearch 命中激活后才出现", () => {
    const r = reg();
    // 注册 6 个 MCP 工具(超过阈值)
    for (let i = 0; i < 6; i++) {
      r.register(defineTool({ name: `mcp__srv__tool_${i}`, description: `tool ${i}`, capability: "network", approval: "suggest", schema: z.object({}), handler: async () => "" }));
    }
    // 超阈值 -> 默认隐藏
    expect(apiToolsForMode(r, "normal").map((t) => t.function.name)).not.toContain("mcp__srv__tool_0");
    // ToolSearch 激活后可见
    r.searchAndActivateMcp("tool_0");
    expect(apiToolsForMode(r, "normal").map((t) => t.function.name)).toContain("mcp__srv__tool_0");
  });
});
