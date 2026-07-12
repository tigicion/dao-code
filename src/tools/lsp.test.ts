import { describe, it, expect } from "vitest";
import { lspTool } from "./lsp.js";

function fakeLsp(overrides: Partial<Record<string, (...a: unknown[]) => unknown>> = {}) {
  const client = {
    definition: async () => "def-result",
    references: async () => "ref-result",
    hover: async () => "hover-result",
    documentSymbol: async () => "symbol-result",
    workspaceSymbol: async () => "wsym-result",
    implementation: async () => "impl-result",
    prepareCallHierarchy: async () => "prep-result",
    incomingCalls: async () => "incoming-result",
    outgoingCalls: async () => "outgoing-result",
    ...overrides,
  };
  return { resolve: () => ({ client }) };
}

describe("lsp", () => {
  it("goToDefinition 路由到 client.definition", async () => {
    const out = await lspTool.handler({ operation: "goToDefinition", filePath: "a.ts", line: 1, character: 1 }, { workspaceRoot: "/w", lsp: fakeLsp() as never });
    expect(out).toBe("def-result");
  });

  it("findReferences 路由到 client.references", async () => {
    const out = await lspTool.handler({ operation: "findReferences", filePath: "a.ts", line: 1, character: 1 }, { workspaceRoot: "/w", lsp: fakeLsp() as never });
    expect(out).toBe("ref-result");
  });

  it("documentSymbol 不需要 line/character", async () => {
    const out = await lspTool.handler({ operation: "documentSymbol", filePath: "a.ts" }, { workspaceRoot: "/w", lsp: fakeLsp() as never });
    expect(out).toBe("symbol-result");
  });

  it("workspaceSymbol 需要 query,没给则报错", async () => {
    const out = await lspTool.handler({ operation: "workspaceSymbol", filePath: "a.ts" }, { workspaceRoot: "/w", lsp: fakeLsp() as never });
    expect(out).toContain("需要 query");
  });

  it("workspaceSymbol 给了 query → 路由到 client.workspaceSymbol", async () => {
    const out = await lspTool.handler({ operation: "workspaceSymbol", filePath: "a.ts", query: "foo" }, { workspaceRoot: "/w", lsp: fakeLsp() as never });
    expect(out).toBe("wsym-result");
  });

  it("非 workspaceSymbol 操作缺 line/character → 报错", async () => {
    const out = await lspTool.handler({ operation: "goToDefinition", filePath: "a.ts" }, { workspaceRoot: "/w", lsp: fakeLsp() as never });
    expect(out).toContain("需要 line 和 character");
  });

  it("未配置该文件类型的 server → 返回 resolve 的 error", async () => {
    const lsp = { resolve: () => ({ error: "没有配置" }) };
    const out = await lspTool.handler({ operation: "hover", filePath: "a.go", line: 1, character: 1 }, { workspaceRoot: "/w", lsp: lsp as never });
    expect(out).toBe("没有配置");
  });

  it("环境不支持 LSP → 提示", async () => {
    const out = await lspTool.handler({ operation: "hover", filePath: "a.ts", line: 1, character: 1 }, { workspaceRoot: "/w" });
    expect(out).toContain("不支持 LSP");
  });

  it("goToImplementation/prepareCallHierarchy/incomingCalls/outgoingCalls 各自路由正确", async () => {
    const l = fakeLsp();
    expect(await lspTool.handler({ operation: "goToImplementation", filePath: "a.ts", line: 1, character: 1 }, { workspaceRoot: "/w", lsp: l as never })).toBe("impl-result");
    expect(await lspTool.handler({ operation: "prepareCallHierarchy", filePath: "a.ts", line: 1, character: 1 }, { workspaceRoot: "/w", lsp: l as never })).toBe("prep-result");
    expect(await lspTool.handler({ operation: "incomingCalls", filePath: "a.ts", line: 1, character: 1 }, { workspaceRoot: "/w", lsp: l as never })).toBe("incoming-result");
    expect(await lspTool.handler({ operation: "outgoingCalls", filePath: "a.ts", line: 1, character: 1 }, { workspaceRoot: "/w", lsp: l as never })).toBe("outgoing-result");
  });
});
