import type { ApiTool } from "../client/types.js";
import type { Lang } from "../i18n/i18n.js";
import type { ToolRegistry } from "./registry.js";
import type { Tool } from "./types.js";

export type Mode = "normal" | "plan";

// MCP 工具数 ≤ 此阈值时自动内联(不 defer),减少模型 ToolSearch 往返。
// 超过此阈值时 MCP 工具默认隐藏,需 ToolSearch 激活后才可见。
const MCP_INLINE_THRESHOLD = 5;

// plan 模式下移除写/执行类工具(只读+提方案);normal 返回全部。
// MCP 可见性策略:
//   - MCP 工具总数 ≤ MCP_INLINE_THRESHOLD:直接内联(模型立即可见,省 ToolSearch 往返)
//   - 超过阈值:未被 ToolSearch 激活的 mcp__ 工具不出现在发给模型的列表里
//     (内置工具集合永远保持不变,前缀缓存不受连了多少 MCP server 影响)。
export function apiToolsForMode(registry: ToolRegistry, mode: Mode, lang?: Lang): ApiTool[] {
  const inlineMcp = registry.countMcpTools() <= MCP_INLINE_THRESHOLD;
  const mcpVisible = (t: Tool) => inlineMcp || registry.isMcpVisible(t.name);
  if (mode === "normal") return registry.toApiTools(mcpVisible, lang);
  return registry.toApiTools((t) => mcpVisible(t) && t.capability !== "write" && t.capability !== "exec", lang);
}
