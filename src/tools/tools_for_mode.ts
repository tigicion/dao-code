import type { ApiTool } from "../client/types.js";
import type { Lang } from "../i18n/i18n.js";
import type { ToolRegistry } from "./registry.js";

export type Mode = "normal" | "plan";

// plan 模式下移除写/执行类工具(只读+提方案);normal 返回全部。
export function apiToolsForMode(registry: ToolRegistry, mode: Mode, lang?: Lang): ApiTool[] {
  if (mode === "normal") return registry.toApiTools(undefined, lang);
  return registry.toApiTools((t) => t.capability !== "write" && t.capability !== "exec", lang);
}
