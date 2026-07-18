import { z } from "zod";
import { defineTool } from "./types.js";

// 搜索延迟加载的内置工具(shouldDefer=true)和 MCP 工具,命中的立即激活。
// 延迟加载工具初始只发 name+简短描述(不发完整 parameters),搜索后返回完整 schema 并激活。
export const toolSearchTool = defineTool({
  name: "ToolSearch",
  description:
    "按关键词(匹配工具名或描述,不分大小写,子串即可)搜索当前未直接可见的工具--包括延迟加载的内置工具(部分低频" +
    "工具初始只显示名称和简短描述,需搜索后才返回完整参数)和 MCP 工具(连了 MCP server 才有)。" +
    "命中的工具立即激活--从下一次工具调用起就能直接按名调用,不需要再调用别的工具去'启用'它,搜到就能用。" +
    "查无结果时换个更宽泛的词试试,而不是反复用同一个词重试。举例:用户要你'在 GitHub 上开个 issue',但工具列表里" +
    "没看到直接能开 issue 的工具--先用 ToolSearch 查'issue'或'github'看有没有连了对应的 MCP server,而不是直接" +
    "回复说做不到。激活是这次会话内长期生效的,不是一次性--同一个工具找到过一次后,后面直接按名调用即可," +
    "不用每次用前都重新搜一遍。",
  descriptionEn:
    "Searches for currently-hidden tools by keyword (matches tool name or description, case-insensitive, substring match) - including deferred built-in tools " +
    "(some low-frequency tools initially show only name + short description, requiring a search to get full parameters) and MCP tools (only if MCP servers are " +
    "connected). Matches are activated immediately - usable by name starting your very next tool call, no separate 'enable' step needed; finding it means you " +
    "can use it. On no match, try a broader term rather than retrying the same one. Example: the user asks you to 'open a GitHub issue' but no tool for that is " +
    "visible - search 'issue' or 'github' via ToolSearch to check whether an MCP server for it is connected, rather than immediately replying that you can't. " +
    "Activation lasts for the rest of this session, not one-shot - once you've found a given tool, call it directly by name afterward instead of searching again each time.",
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
