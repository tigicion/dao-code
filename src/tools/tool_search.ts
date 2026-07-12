import { z } from "zod";
import { defineTool } from "./types.js";

// MCP 工具默认不进每轮发给模型的工具列表(server 多、工具多时是每轮重复的静态开销,
// 且会让内置工具集合以外的部分拖累前缀缓存)。本工具按关键词搜 MCP 工具,命中的
// 立即激活——从下一次工具调用起就能直接用它,不需要再额外一步"激活"。
// 内置的 24 个工具、task_*、notify_user 等永远可见,不需要(也不能)被搜到。
export const toolSearchTool = defineTool({
  name: "tool_search",
  description:
    "按关键词搜索当前未直接可见的 MCP 工具(连了 MCP server 才有意义)。命中的工具立即激活," +
    "从你下一次工具调用起就能直接按名调用——不需要再调用别的工具去'启用'它。" +
    "只用于找 MCP 工具;dao 自带的内置工具永远都在,不需要搜。",
  descriptionEn:
    "Searches for currently-hidden MCP tools by keyword (only relevant if MCP servers are connected). Matches are activated immediately — " +
    "usable by name starting your very next tool call, no separate 'enable' step needed. " +
    "Only for finding MCP tools; dao's own built-in tools are always visible and never need searching.",
  capability: "read",
  approval: "auto",
  schema: z.object({
    query: z.string().min(1).describe("搜索关键词(匹配工具名或描述,不分大小写)"),
  }),
  handler: async (args, ctx) => {
    if (!ctx.searchTools) return "当前环境不支持工具搜索。";
    return ctx.searchTools(args.query);
  },
});
