import type { ApiTool } from "../client/types.js";
import type { Lang } from "../i18n/i18n.js";
import type { ToolRegistry } from "./registry.js";

export type Mode = "normal" | "plan";

// plan 模式下移除写/执行类工具(只读+提方案),并且一律排除 MCP 工具——MCP 工具目前统一打
// capability:"network"(协议本身不区分只读查询和会改数据的调用,没法像内置工具那样按 capability
// 甄别是否安全),而 network 在别处是专门为 WebSearch/WebFetch 这类明确只读的工具开的口子,MCP
// 工具混进同一个 capability 值会绕过 plan 模式的只读边界(比如某 server 暴露的 create_issue/
// send_email)。plan 模式下没有办法验证一个第三方 MCP 工具到底是不是只读,所以直接不给看、不给
// 机会调用,而不是信任它的 capability 标签。
// MCP 可见性:内置工具集合永远保持不变,前缀缓存不受连了多少 MCP server 影响;单个 MCP 工具的
// 可见性由 registry 在【注册那一刻】一次性决定(见 registry.ts 的自动激活逻辑),这里只读取,
// 不再按"当前 MCP 工具总数"每轮重新判定。
export function apiToolsForMode(registry: ToolRegistry, mode: Mode, lang?: Lang): ApiTool[] {
  // hideUnactivatedDeferred:这里是真正发给模型用于函数调用的 tools 数组,未激活的延迟
  // 工具整条不出现(不再是占位空 schema),避免模型对着占位 schema 猜参数硬调。
  if (mode === "normal") {
    return registry.toApiTools((t) => registry.isMcpVisible(t.name), lang, { hideUnactivatedDeferred: true });
  }
  return registry.toApiTools(
    (t) => !t.name.startsWith("mcp__") && t.capability !== "write" && t.capability !== "exec",
    lang,
    { hideUnactivatedDeferred: true },
  );
}
