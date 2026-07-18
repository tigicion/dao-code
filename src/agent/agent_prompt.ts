// src/agent/agent_prompt.ts
import type { AgentDef } from "./agent_defs.js";

/**
 * 格式化单行 agent 描述(用于 agent 列表)。
 * 格式: - <type>: <whenToUse> (Tools: <tools>)
 */
export function formatAgentLine(agent: AgentDef): string {
  const toolsDescription = getToolsDescription(agent);
  return `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${toolsDescription})`;
}

/**
 * 获取 agent 的工具描述文本。
 * - 有白名单:列出具体工具
 * - 有黑名单:"全部工具除了 X, Y, Z"
 * - 同时有:白名单过滤黑名单后列出
 * - 无限制:"全部工具"
 */
export function getToolsDescription(agent: Pick<AgentDef, "tools" | "disallowedTools">): string {
  const { tools, disallowedTools } = agent;
  const hasAllowlist = tools && tools.length > 0;
  const hasDenylist = disallowedTools && disallowedTools.length > 0;

  if (hasAllowlist && hasDenylist) {
    const denySet = new Set(disallowedTools!);
    const effectiveTools = tools!.filter((t) => !denySet.has(t));
    if (effectiveTools.length === 0) return "无";
    return effectiveTools.join(", ");
  } else if (hasAllowlist) {
    return tools!.join(", ");
  } else if (hasDenylist) {
    return `全部工具除了 ${disallowedTools!.join(", ")}`;
  }
  return "全部工具";
}

