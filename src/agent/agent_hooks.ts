// src/agent/agent_hooks.ts
import type { AgentHooks, HookCommand } from "./agent_defs.js";
import { runHooks, type HookSpec, type HookOutcome } from "../hooks/hooks.js";

/**
 * Agent hook 注册表:agentId -> 注册的 hooks。
 * 在 runAgent 阶段 3 注册,阶段 7(finally)清除。
 */
export type AgentHookRegistry = Map<string, AgentHooks>;

/**
 * 注册 agent 的 frontmatter hooks 到注册表(参考 registerFrontmatterHooks)。
 *
 * 这些 hooks 在 agent 生命周期内生效:
 * - SubagentStart:会话创建后、首轮查询前执行
 * - SubagentStop:会话结束(完成/失败/取消)时执行
 */
export function registerAgentHooks(
  agentId: string,
  hooks: AgentHooks,
  registry: AgentHookRegistry,
): void {
  if (!hooks || Object.keys(hooks).length === 0) return;
  registry.set(agentId, hooks);
}

/**
 * 清除 agent 的所有 hooks(参考 clearSessionHooks)。
 * 在 runAgent 的 finally 阶段调用。
 */
export function clearAgentHooks(
  agentId: string,
  registry: AgentHookRegistry,
): void {
  registry.delete(agentId);
}

/**
 * 执行 SubagentStart hooks 并收集 additionalContext(参考 executeSubagentStartHooks)。
 *
 * 在 runAgent 阶段 3 调用:注册 hooks 后、首轮查询前。
 * hook 的 additionalContext 输出作为 initial message 注入。
 *
 * 复用 DAO 现有 runHooks() 机制执行 command 类型 hook。
 */
export async function executeSubagentStartHooks(
  agentId: string,
  agentType: string,
  registry: AgentHookRegistry,
  cwd: string,
): Promise<HookOutcome> {
  const entry = registry.get(agentId);
  if (!entry?.SubagentStart || entry.SubagentStart.length === 0) {
    return { block: false, reason: "", additionalContext: "" };
  }

  // 把 AgentHooks.SubagentStart 转为 HookSpec[]
  const specs: HookSpec[] = entry.SubagentStart.map((cmd: HookCommand) => ({
    event: "SubagentStart",
    type: "command" as const,
    command: cmd.command,
  }));

  const payload = {
    hook_event_name: "SubagentStart",
    agent_id: agentId,
    agent_type: agentType,
  };

  return runHooks(specs, "SubagentStart", { cwd, payload });
}

/**
 * 执行 SubagentStop hooks(参考 clearSessionHooks 时的 Stop 执行)。
 *
 * 在 runAgent 阶段 7(finally)调用。
 * 不收集 additionalContext(会话已结束),只执行命令。
 */
export async function executeSubagentStopHooks(
  agentId: string,
  agentType: string,
  registry: AgentHookRegistry,
  cwd: string,
): Promise<void> {
  const entry = registry.get(agentId);
  if (!entry?.SubagentStop || entry.SubagentStop.length === 0) return;

  const specs: HookSpec[] = entry.SubagentStop.map((cmd: HookCommand) => ({
    event: "SubagentStop",
    type: "command" as const,
    command: cmd.command,
  }));

  const payload = {
    hook_event_name: "SubagentStop",
    agent_id: agentId,
    agent_type: agentType,
  };

  await runHooks(specs, "SubagentStop", { cwd, payload }).catch(() => {});
}
