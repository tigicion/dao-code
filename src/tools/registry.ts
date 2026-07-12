import type { ApiTool } from "../client/types.js";
import { toJsonSchema } from "./schema.js";
import type { Tool, ToolContext, ToolDispatcher } from "./types.js";
import type { Lang } from "../i18n/i18n.js";

export class ToolRegistry implements ToolDispatcher {
  // Map 保留插入顺序 → toApiTools 输出稳定,利于前缀 cache。
  private tools = new Map<string, Tool>();
  // MCP 工具默认不进每轮发给模型的 tools 数组(避免连了很多 server 时,每轮都为一堆可能用不到的
  // 工具付 token;更关键的是内置工具集合永远保持不变,前缀缓存不受 MCP 工具数量影响)。
  // 通过 tool_search 命中后加入此集合,从下一轮起才会出现在 tools 里——这一步本身会让 tools 数组变化
  // 一次(不可避免,调用新工具前模型必须先在某一轮看到它的 schema),但只在真正用到某个 MCP 工具时才发生,
  // 不是每轮都发全部。
  private activatedMcp = new Set<string>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  // mcp__ 前缀之外的工具永远可见;mcp__ 工具只有被 tool_search 命中激活后才可见。
  isMcpVisible(name: string): boolean {
    return !name.startsWith("mcp__") || this.activatedMcp.has(name);
  }

  // 按名/描述关键词(不分大小写、子串)搜 MCP 工具,命中的立即激活(下一轮起可见),
  // 返回给模型的确认文本(名字+描述,供其确认要调用哪个)。
  searchAndActivateMcp(query: string): string {
    const q = query.trim().toLowerCase();
    if (!q) return "请提供搜索关键词。";
    const hits: Tool[] = [];
    for (const t of this.tools.values()) {
      if (!t.name.startsWith("mcp__")) continue;
      if (t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)) hits.push(t);
    }
    if (hits.length === 0) return `没有 MCP 工具匹配「${query}」。`;
    for (const t of hits) this.activatedMcp.add(t.name);
    return hits.map((t) => `${t.name}: ${t.description}`).join("\n") +
      `\n\n(以上 ${hits.length} 个工具已激活,从下一次工具调用起可直接调用它们。)`;
  }

  // 按工具名白名单建子集(自定义 agent 类型的 tools 限制用);保持插入顺序。
  subset(names: Set<string>): ToolRegistry {
    const r = new ToolRegistry();
    for (const [n, t] of this.tools) if (names.has(n)) r.register(t);
    return r;
  }

  // 按排除名建子集(自定义 agent 的 "*, !tool" 排除式用);保持插入顺序。
  subsetExcluding(names: Set<string>): ToolRegistry {
    const r = new ToolRegistry();
    for (const [n, t] of this.tools) if (!names.has(n)) r.register(t);
    return r;
  }

  toApiTools(predicate?: (tool: Tool) => boolean, lang?: Lang): ApiTool[] {
    return [...this.tools.values()]
      .filter((t) => (predicate ? predicate(t) : true))
      .map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: lang === "en" && t.descriptionEn ? t.descriptionEn : t.description,
          parameters: t.apiParameters ?? toJsonSchema(t.schema),
        },
      }));
  }

  async dispatch(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);

    let json: unknown;
    try {
      json = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch {
      throw new Error(`invalid JSON arguments for ${name}`);
    }

    const args = tool.schema.parse(json); // 非法参数抛 ZodError
    return tool.handler(args, ctx);
  }
}
