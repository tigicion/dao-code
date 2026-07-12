import { z } from "zod";
import { defineTool } from "./types.js";

// MCP 工具默认不进每轮发给模型的工具列表(server 多、工具多时是每轮重复的静态开销,
// 且会让内置工具集合以外的部分拖累前缀缓存)。本工具按关键词搜 MCP 工具,命中的
// 立即激活——从下一次工具调用起就能直接用它,不需要再额外一步"激活"。
// 内置的 24 个工具、task_*、notify_user 等永远可见,不需要(也不能)被搜到。
export const toolSearchTool = defineTool({
  name: "tool_search",
  description:
    "按关键词(匹配工具名或描述,不分大小写,子串即可)搜索当前未直接可见的 MCP 工具(连了 MCP server 才有意义)。" +
    "命中的工具立即激活——从你下一次工具调用起就能直接按名调用,不需要再调用别的工具去'启用'它,搜到就能用。" +
    "只用于找 MCP 工具;dao 自带的内置工具、task_*、notify_user 这些永远都在工具列表里,搜不到也不需要搜。" +
    "查无结果时换个更宽泛的词试试,而不是反复用同一个词重试。举例:用户要你'在 GitHub 上开个 issue',但工具列表里" +
    "没看到直接能开 issue 的工具——先用 tool_search 查'issue'或'github'看有没有连了对应的 MCP server,而不是直接" +
    "回复说做不到。激活是这次会话内长期生效的,不是一次性——同一个 MCP 工具找到过一次后,后面直接按名调用即可," +
    "不用每次用前都重新搜一遍。",
  descriptionEn:
    "Searches for currently-hidden MCP tools by keyword (matches tool name or description, case-insensitive, substring match — only relevant if MCP servers are " +
    "connected). Matches are activated immediately — usable by name starting your very next tool call, no separate 'enable' step needed; finding it means you " +
    "can use it. Only for finding MCP tools; dao's own built-in tools, task_*, notify_user etc. are always in the tool list, won't show up here and don't need " +
    "searching. On no match, try a broader term rather than retrying the same one. Example: the user asks you to 'open a GitHub issue' but no tool for that is " +
    "visible — search 'issue' or 'github' via tool_search to check whether an MCP server for it is connected, rather than immediately replying that you can't. " +
    "Activation lasts for the rest of this session, not one-shot — once you've found a given MCP tool, call it directly by name afterward instead of searching again each time.",
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
