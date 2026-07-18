import { describe, it, expect } from "vitest";
import { toolSearchTool } from "./tool_search.js";

describe("ToolSearch", () => {
  it("调用 ctx.searchTools 并返回结果", async () => {
    const out = await toolSearchTool.handler(
      { query: "issue" },
      { workspaceRoot: "/w", searchTools: (q) => `mcp__github__create_issue: 建 issue(命中「${q}」)` },
    );
    expect(out).toContain("mcp__github__create_issue");
  });

  it("环境不支持 → 提示", async () => {
    const out = await toolSearchTool.handler({ query: "x" }, { workspaceRoot: "/w" });
    expect(out).toContain("不支持工具搜索");
  });
});
