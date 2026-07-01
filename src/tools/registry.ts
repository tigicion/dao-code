import type { ApiTool } from "../client/types.js";
import { toJsonSchema } from "./schema.js";
import type { Tool, ToolContext, ToolDispatcher } from "./types.js";
import type { Lang } from "../i18n/i18n.js";

export class ToolRegistry implements ToolDispatcher {
  // Map 保留插入顺序 → toApiTools 输出稳定,利于前缀 cache。
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
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
