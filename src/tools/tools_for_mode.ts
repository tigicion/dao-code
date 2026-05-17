import type { ApiTool } from "../client/types.js";
import type { ToolRegistry } from "./registry.js";

export type Mode = "normal" | "plan";

// plan 模式下移除写/执行类工具(只读+提方案);normal 返回全部。
export function apiToolsForMode(registry: ToolRegistry, mode: Mode): ApiTool[] {
  if (mode === "normal") return registry.toApiTools();
  return registry.toApiTools((t) => t.capability !== "write" && t.capability !== "exec");
}
