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

  it("前 5 个注册的 MCP 工具自动激活(不需 ToolSearch)", () => {
    const r = reg();
    r.register(defineTool({ name: "mcp__github__create_issue", description: "建 issue", capability: "network", approval: "suggest", schema: z.object({}), handler: async () => "" }));
    // 注册顺序里的第 1 个,在自动激活上限(5)以内 -> 直接可见
    expect(apiToolsForMode(r, "normal").map((t) => t.function.name)).toContain("mcp__github__create_issue");
  });

  it("第 6 个及以后注册的 MCP 工具默认不出现,ToolSearch 命中激活后才出现", () => {
    const r = reg();
    for (let i = 0; i < 6; i++) {
      r.register(defineTool({ name: `mcp__srv__tool_${i}`, description: `tool ${i}`, capability: "network", approval: "suggest", schema: z.object({}), handler: async () => "" }));
    }
    // 第 6 个(索引 5,超出自动激活上限)-> 默认隐藏
    expect(apiToolsForMode(r, "normal").map((t) => t.function.name)).not.toContain("mcp__srv__tool_5");
    // ToolSearch 激活后可见
    r.searchAndActivateMcp("tool_5");
    expect(apiToolsForMode(r, "normal").map((t) => t.function.name)).toContain("mcp__srv__tool_5");
  });

  it("MCP 工具数跨过自动激活上限时,已经可见的前几个不会被撤销(不闪烁)", () => {
    // 回归测试:旧版按"当前 MCP 工具总数 <= 阈值"每轮重新判定,工具数一跨过阈值,
    // 已经内联、模型正在用的工具会集体从下一轮的工具列表里消失。
    const r = reg();
    for (let i = 0; i < 5; i++) {
      r.register(defineTool({ name: `mcp__srv__tool_${i}`, description: `tool ${i}`, capability: "network", approval: "suggest", schema: z.object({}), handler: async () => "" }));
    }
    const before = apiToolsForMode(r, "normal").map((t) => t.function.name);
    expect(before).toEqual(expect.arrayContaining(["mcp__srv__tool_0", "mcp__srv__tool_1", "mcp__srv__tool_2", "mcp__srv__tool_3", "mcp__srv__tool_4"]));
    // 再连一个新 server,总数从 5 涨到 6
    r.register(defineTool({ name: "mcp__srv2__tool_a", description: "a", capability: "network", approval: "suggest", schema: z.object({}), handler: async () => "" }));
    const after = apiToolsForMode(r, "normal").map((t) => t.function.name);
    // 之前那 5 个仍然可见,不会因为总数跨过阈值而集体消失
    for (const name of before) expect(after).toContain(name);
    // 新连的第 6 个默认不可见(需要 ToolSearch)
    expect(after).not.toContain("mcp__srv2__tool_a");
  });

  it("plan 模式下 MCP 工具一律不可见,即使已经自动激活(capability:network 不能绕过只读边界)", () => {
    const r = reg();
    r.register(defineTool({ name: "mcp__github__create_issue", description: "建 issue", capability: "network", approval: "suggest", schema: z.object({}), handler: async () => "" }));
    expect(apiToolsForMode(r, "normal").map((t) => t.function.name)).toContain("mcp__github__create_issue"); // normal 下可见
    expect(apiToolsForMode(r, "plan").map((t) => t.function.name)).not.toContain("mcp__github__create_issue"); // plan 下不可见
  });
});
