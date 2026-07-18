import { z } from "zod";
import { defineTool } from "./types.js";

const OPS = [
  "goToDefinition", "findReferences", "hover", "documentSymbol", "workspaceSymbol",
  "goToImplementation", "prepareCallHierarchy", "incomingCalls", "outgoingCalls",
] as const;
type Op = (typeof OPS)[number];

// 不接入任何语言的二进制:纯协议客户端,server 命令由用户在 .dao/lsp.json 配(见 src/lsp/config.ts)。
// 没配置对应文件类型的语言 → 报错,不负责帮用户装。操作集合统一 的 LSP 工具接口。
export const lspTool = defineTool({
  name: "LSP",
  description:
    "用语言服务器(LSP)做语义级代码理解:goToDefinition 跳转定义 / findReferences 查全部引用 / hover 看类型信息 / " +
    "documentSymbol 列出整个文件的符号 / workspaceSymbol 按名搜整个工作区的符号 / goToImplementation 找接口的实现 / " +
    "prepareCallHierarchy 在函数上建立调用层级条目、incomingCalls 查谁调用了它、outgoingCalls 查它调用了谁" +
    "(这两个内部会自动先 prepareCallHierarchy,不用你分两步调)。line/character 都是 1-based(同编辑器/Read" +
    "的行号习惯),workspaceSymbol 用 query 不用 line/character,documentSymbol 不需要具体位置。\n" +
    "'某个标识符实际指向哪、被谁用了'这类语义问题用 lsp,比 Grep 精确(理解代码语义,不会把同名但无关的字符串" +
    "误判为同一个符号);单纯按文本/正则找字符串还是用 Grep 更快。只对 .dao/lsp.json 配置过 server 的文件类型" +
    "有效——没配置会直接报错说明缺什么配置,不会静默退化成瞎猜的答案。",
  descriptionEn:
    "Uses a Language Server (LSP) for semantic code understanding: goToDefinition / findReferences (all usages) / hover (type info) / documentSymbol " +
    "(list all symbols in a file) / workspaceSymbol (search symbols by name across the workspace) / goToImplementation (find interface implementations) / " +
    "prepareCallHierarchy (establish a call-hierarchy item at a position) / incomingCalls (who calls it) / outgoingCalls (what it calls) — the latter two " +
    "automatically run prepareCallHierarchy internally, no need to call it separately first. line/character are 1-based (matching editor/Read convention); " +
    "workspaceSymbol uses query instead of line/character, documentSymbol needs no position at all.\n" +
    "Use lsp for semantic questions like 'what does this identifier actually resolve to, who uses it' — more precise than Grep (understands code semantics, " +
    "won't mistake an unrelated same-named string for the same symbol); for plain text/regex string matching, Grep is faster. Only works for file types with " +
    "a server configured in .dao/lsp.json — errors with what's missing rather than silently degrading into a guessed answer.",
  capability: "read",
  approval: "auto",
  shouldDefer: true,
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
