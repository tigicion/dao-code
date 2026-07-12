import { z } from "zod";
import { defineTool } from "./types.js";

const OPS = [
  "goToDefinition", "findReferences", "hover", "documentSymbol", "workspaceSymbol",
  "goToImplementation", "prepareCallHierarchy", "incomingCalls", "outgoingCalls",
] as const;
type Op = (typeof OPS)[number];

// 不接入任何语言的二进制:纯协议客户端,server 命令由用户在 .dao/lsp.json 配(见 src/lsp/config.ts)。
// 没配置对应文件类型的语言 → 报错,不负责帮用户装。操作集合对齐 CC 的 LSP 工具接口。
export const lspTool = defineTool({
  name: "lsp",
  description:
    "用语言服务器(LSP)做语义级代码理解:跳转定义/查引用/hover 类型信息/列出文件符号/按名搜工作区符号/" +
    "找接口实现/建调用层级并查调用方或被调用方。比 grep_files 精确(理解代码语义,不是纯文本匹配)," +
    "但只对 .dao/lsp.json 配置过 server 的文件类型有效——没配置会报错,不会静默退化。",
  descriptionEn:
    "Uses a Language Server (LSP) for semantic code understanding: go to definition/find references/hover type info/list document symbols/search workspace symbols by name/" +
    "find interface implementations/build a call hierarchy and query callers or callees. More precise than grep_files (understands code semantics, not plain text matching), " +
    "but only works for file types with a server configured in .dao/lsp.json — errors rather than silently degrading if none is configured.",
  capability: "read",
  approval: "auto",
  schema: z.object({
    operation: z.enum(OPS).describe("要执行的 LSP 操作"),
    filePath: z.string().min(1).describe("文件路径(相对工作区根目录);workspaceSymbol 时用它决定去哪个 server 查"),
    line: z.number().int().min(1).optional().describe("行号(1-based,同编辑器习惯)。除 workspaceSymbol 外必填"),
    character: z.number().int().min(1).optional().describe("列号(1-based,同编辑器习惯)。除 workspaceSymbol 外必填"),
    query: z.string().optional().describe("符号名/部分名(仅 workspaceSymbol 用)"),
  }),
  handler: async (args, ctx) => {
    if (!ctx.lsp) return "当前环境不支持 LSP。";
    const r = ctx.lsp.resolve(args.filePath);
    if ("error" in r) return r.error;
    const { client } = r;
    const op = args.operation as Op;
    if (op === "workspaceSymbol") {
      if (!args.query) return "workspaceSymbol 需要 query 参数。";
      return client.workspaceSymbol(args.query);
    }
    if (op === "documentSymbol") return client.documentSymbol(args.filePath); // 列整个文件,不需要具体位置
    if (args.line === undefined || args.character === undefined) return `${op} 需要 line 和 character 参数。`;
    const { line, character } = args;
    switch (op) {
      case "goToDefinition": return client.definition(args.filePath, line, character);
      case "findReferences": return client.references(args.filePath, line, character);
      case "hover": return client.hover(args.filePath, line, character);
      case "goToImplementation": return client.implementation(args.filePath, line, character);
      case "prepareCallHierarchy": return client.prepareCallHierarchy(args.filePath, line, character);
      case "incomingCalls": return client.incomingCalls(args.filePath, line, character);
      case "outgoingCalls": return client.outgoingCalls(args.filePath, line, character);
    }
  },
});
