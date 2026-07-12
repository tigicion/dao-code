import type { ApiTool } from "../client/types.js";
import type { Lang } from "../i18n/i18n.js";
import type { ToolRegistry } from "./registry.js";
import type { Tool } from "./types.js";

export type Mode = "normal" | "plan";

// plan 模式下移除写/执行类工具(只读+提方案);normal 返回全部。
// 两种模式都额外应用 MCP 可见性过滤:未被 tool_search 激活的 mcp__ 工具不出现在发给模型的列表里
// (内置工具集合保持不变,前缀缓存不受连了多少 MCP server 影响)。
export function apiToolsForMode(registry: ToolRegistry, mode: Mode, lang?: Lang): ApiTool[] {
  const mcpVisible = (t: Tool) => registry.isMcpVisible(t.name);
  if (mode === "normal") return registry.toApiTools(mcpVisible, lang);
  return registry.toApiTools((t) => mcpVisible(t) && t.capability !== "write" && t.capability !== "exec", lang);
}
