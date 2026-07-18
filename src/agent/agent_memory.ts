// src/agent/agent_memory.ts
import { join, normalize, sep } from "node:path";
import { promises as fs } from "node:fs";
import type { AgentMemoryScope } from "./agent_defs.js";

// agentType 中冒号替换为横线(跨平台路径安全)
function sanitizeAgentTypeForPath(agentType: string): string {
  return agentType.replace(/:/g, "-");
}

/**
 * 返回 agent 记忆目录(对标 CC getAgentMemoryDir)。
 * - user: <home>/.dao/agents/memory/<agentType>/
 * - project: <cwd>/.dao/agents/memory/<agentType>/
 * - local: <cwd>/.dao/agents/memory/<agentType>/local/
 */
export function getAgentMemoryDir(
  agentType: string,
  scope: AgentMemoryScope,
  homeDir: string = process.env.HOME ?? process.cwd(),
): string {
  const dirName = sanitizeAgentTypeForPath(agentType);
  switch (scope) {
    case "project":
      return join(process.cwd(), ".dao", "agents", "memory", dirName) + sep;
    case "local":
      return join(process.cwd(), ".dao", "agents", "memory", dirName, "local") + sep;
    case "user":
      return join(homeDir, ".dao", "agents", "memory", dirName) + sep;
  }
}

/**
 * 返回 agent 记忆文件入口路径(memory.md)。
 */
export function getAgentMemoryEntrypoint(
  agentType: string,
  scope: AgentMemoryScope,
  homeDir?: string,
): string {
  return join(getAgentMemoryDir(agentType, scope, homeDir), "memory.md");
}

/**
 * 检查路径是否在 agent 记忆目录内(任意 scope)。
 * 安全:先 normalize 防止 .. 路径穿越绕过。
 */
export function isAgentMemoryPath(absolutePath: string, homeDir?: string): boolean {
  const normalizedPath = normalize(absolutePath);
  const home = homeDir ?? process.env.HOME ?? process.cwd();

  if (normalizedPath.startsWith(join(home, ".dao", "agents", "memory") + sep)) {
    return true;
  }

  if (normalizedPath.startsWith(join(process.cwd(), ".dao", "agents", "memory") + sep)) {
    return true;
  }

  return false;
}

/**
 * 返回 scope 的显示文本。
 */
export function getMemoryScopeDisplay(
  memory: AgentMemoryScope | undefined,
  homeDir?: string,
): string {
  const home = homeDir ?? process.env.HOME ?? process.cwd();
  switch (memory) {
    case "user":
      return `User (${join(home, ".dao", "agents", "memory")}/)`;
    case "project":
      return "Project (.dao/agents/memory/)";
    case "local":
      return `Local (${join(process.cwd(), ".dao", "agents", "memory", "...", "local")}/)`;
    default:
      return "None";
  }
}

/**
 * 加载 agent 持久记忆并返回 prompt 文本(对标 CC loadAgentMemoryPrompt)。
 * 在 runAgent 阶段 2 追加到 system prompt。
 * agent 通过 Read/Write/Edit 直接读写 memory.md。
 */
export function loadAgentMemoryPrompt(
  agentType: string,
  scope: AgentMemoryScope,
  homeDir?: string,
): string {
  let scopeNote: string;
  switch (scope) {
    case "user":
      scopeNote = "- 此记忆是 user 级(跨项目),请保持学习的通用性,因为它们适用于所有项目";
      break;
    case "project":
      scopeNote = "- 此记忆是 project 级(随版本控制共享给团队),请针对本项目记录";
      break;
    case "local":
      scopeNote = "- 此记忆是 local 级(不入版本控制),请针对本地本项目和本机记录";
      break;
  }

  const memoryDir = getAgentMemoryDir(agentType, scope, homeDir);
  const memoryFile = join(memoryDir, "memory.md");

  // fire-and-forget:确保目录存在
  void fs.mkdir(memoryDir, { recursive: true }).catch(() => {});

  return `## 持久 Agent 记忆

你有持久记忆,存储在 ${memoryFile}。
你可以用 Read 读取记忆、用 Write/Edit 更新记忆。

记忆使用指南:
- 只记耐久且可泛化的:项目结构、关键决策、踩过的坑、用户偏好
- 不记一次性或显而易见的
- 每条记忆用简洁的一句话
${scopeNote}

当前记忆文件路径: ${memoryFile}`;
}
