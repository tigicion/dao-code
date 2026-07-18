import type { ApiTool } from "../client/types.js";
import { toJsonSchema } from "./schema.js";
import type { Tool, ToolContext, ToolDispatcher } from "./types.js";
import type { Lang } from "../i18n/i18n.js";

// 半截 JSON 抢救:真实撞见过(20260717-143212-b8wt)单次输出预算不够,模型试图一次性生成
// 超大内容(如整篇文档塞进 write_file 的 content 字段)被硬截断——原来只报一句"invalid JSON
// arguments",模型看不出截断在哪、截了多少,只会原地重试同一个必然还是太大的调用。
// 这里做最小化的"尽量往回补全":扫描字符流,跟踪是否在字符串内(正确处理转义)及未闭合的
// {}/[] 层级,截断多半发生在某个字符串值中途——补一个闭合引号 + 按层级倒序补齐括号,再重新解析。
// 只用于诊断/报错文案,不代表拿这份不完整数据去真的执行工具(内容不完整,写入不安全)。
function tryRepairTruncatedJson(raw: string): Record<string, unknown> | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const c of raw) {
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (c === "\\") { escaped = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") stack.pop();
  }
  let repaired = raw;
  if (inString) repaired += '"';
  for (let i = stack.length - 1; i >= 0; i--) repaired += stack[i] === "{" ? "}" : "]";
  try {
    const parsed = JSON.parse(repaired);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// 把抢救出的半截参数拼成给模型看的诊断文案:字符串字段报长度 + 结尾预览,方便判断截在哪。
function describeTruncatedArgs(partial: Record<string, unknown>): string {
  return Object.entries(partial)
    .map(([k, v]) => {
      if (typeof v !== "string") return `${k}=${JSON.stringify(v)}`;
      const tail = v.length > 60 ? `…${v.slice(-60)}` : v;
      return `${k}(${v.length} 字符,结尾"${tail}")`;
    })
    .join("; ");
}

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
          description: t.prompt ? t.prompt({ lang: lang === "en" ? "en" : "zh" })
            : (lang === "en" && t.descriptionEn ? t.descriptionEn : t.description),
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
      const partial = tryRepairTruncatedJson(rawArgs);
      if (partial) {
        throw new Error(
          `invalid JSON arguments for ${name}(输出在生成过程中被截断,未执行——已生成到:${describeTruncatedArgs(partial)}。` +
          `这次内容太长,把它拆成更小的几次调用:比如先用 write_file 写一部分,再用 edit_file/multi_edit 续写剩余内容,不要试图一次性重新生成同样长度的内容。)`,
        );
      }
      throw new Error(`invalid JSON arguments for ${name}`);
    }

    const args = tool.schema.parse(json); // 非法参数抛 ZodError
    return tool.handler(args, ctx);
  }
}
