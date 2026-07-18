import { promises as fs } from "node:fs";
import path from "node:path";
import type { Mode } from "../tools/tools_for_mode.js";
import type { ToolContext } from "../tools/types.js";

// Agent 来源
export type AgentSource = "built-in" | "userSettings" | "projectSettings" | "plugin";

// MCP 服务器规格:字符串引用 或 内联定义
export type AgentMcpServerSpec =
  | string
  | { [name: string]: { command?: string; args?: string[]; env?: Record<string, string> } };

// Hook 命令
export interface HookCommand {
  command: string;
}

// Agent 生命周期 hooks
export interface AgentHooks {
  SubagentStart?: HookCommand[];
  SubagentStop?: HookCommand[];
}

// 持久记忆 scope
export type AgentMemoryScope = "user" | "project" | "local";

// 基础字段(所有来源共用)
export interface BaseAgentDef {
  agentType: string;
  whenToUse: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  permissionMode?: Mode;
  maxTurns?: number;
  skills?: string[];
  hooks?: AgentHooks;
  memory?: AgentMemoryScope;
  background?: boolean;
  isolation?: "worktree";
  color?: string;
  omitClaudeMd?: boolean;
  initialPrompt?: string;
  mcpServers?: AgentMcpServerSpec[];
  requiredMcpServers?: string[];
  source: AgentSource;
  filename?: string;
  baseDir?: string;
}

// 内置 agent
export interface BuiltInAgentDef extends BaseAgentDef {
  source: "built-in";
  getSystemPrompt: (params: { toolUseContext: ToolContext }) => string;
}

// 自定义 agent
export interface CustomAgentDef extends BaseAgentDef {
  source: "userSettings" | "projectSettings";
  getSystemPrompt: () => string;
}

// 插件 agent
export interface PluginAgentDef extends BaseAgentDef {
  source: "plugin";
  getSystemPrompt: () => string;
  plugin: string;
}

export type AgentDef = BuiltInAgentDef | CustomAgentDef | PluginAgentDef;

// ---- frontmatter 解析 ----

function parseFrontmatter(raw: string): { fm: Record<string, string>; fmRaw: Record<string, unknown>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, fmRaw: {}, body: raw };
  const fm: Record<string, string> = {};
  const fmRaw: Record<string, unknown> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) {
      const key = line.slice(0, i).trim();
      const val = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      fm[key.toLowerCase()] = val;
      // 简单值:不解析复杂 YAML,字符串值直接存
      fmRaw[key] = val;
    }
  }
  // 简单解析 hooks(多行嵌套)和 mcpServers(列表)
  // 对 hooks 和 mcpServers 做特殊处理
  const fullFm = m[1]!;
  parseHooksSection(fullFm, fmRaw);
  parseMcpServersSection(fullFm, fmRaw);
  return { fm, fmRaw, body: (m[2] ?? "").trim() };
}

function parseHooksSection(fmText: string, fmRaw: Record<string, unknown>): void {
  // 匹配 hooks: 下面的 SubagentStart/SubagentStop 段
  const hooksMatch = fmText.match(/hooks:\s*\n([\s\S]*?)(?=\n\S|\n---|$)/);
  if (!hooksMatch) return;
  const hooksBlock = hooksMatch[1]!;
  const hooks: AgentHooks = {};
  for (const evt of ["SubagentStart", "SubagentStop"] as const) {
    const evtMatch = hooksBlock.match(new RegExp(`  ${evt}:\\s*\\n([\\s\\S]*?)(?=\\n  \\S|\\n*$|$)`));
    if (!evtMatch) continue;
    const cmds: HookCommand[] = [];
    for (const line of evtMatch[1]!.split(/\n/)) {
      const cmdMatch = line.match(/^\s*-\s*command:\s*"?(.+?)"?\s*$/);
      if (cmdMatch) cmds.push({ command: cmdMatch[1]! });
    }
    if (cmds.length > 0) hooks[evt] = cmds;
  }
  if (Object.keys(hooks).length > 0) fmRaw.hooks = hooks;
}

function parseMcpServersSection(fmText: string, fmRaw: Record<string, unknown>): void {
  const mcpMatch = fmText.match(/mcpServers:\s*\n([\s\S]*?)(?=\n\S|\n---|$)/);
  if (!mcpMatch) return;
  const specs: AgentMcpServerSpec[] = [];
  for (const line of mcpMatch[1]!.split(/\n/)) {
    const ref = line.match(/^\s*-\s+(\S+)\s*$/);
    if (ref) {
      specs.push(ref[1]!);
    }
  }
  if (specs.length > 0) fmRaw.mcpServers = specs;
}

export function parseAgentDef(filename: string, raw: string, source: AgentSource = "userSettings"): CustomAgentDef | null {
  const { fm, fmRaw, body } = parseFrontmatter(raw);
  const name = fm.name?.trim();
  if (!name || !body) return null;

  const toolsRaw = fm.tools ?? fm["allowed-tools"] ?? fm.allowedtools ?? "";
  const tokens = toolsRaw ? toolsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const exclude = tokens.filter((t) => t.startsWith("!")).map((t) => t.slice(1).trim()).filter(Boolean);
  const include = tokens.filter((t) => t !== "*" && !t.startsWith("!"));
  const hasStar = tokens.includes("*");
  const tools = include.length > 0 && !hasStar ? include : undefined;
  const disallowedTools = exclude.length > 0 ? exclude : fm.disallowedtools ? fm.disallowedtools.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  const modelRaw = fm.model;
  let model: string | undefined;
  if (modelRaw) {
    const trimmed = modelRaw.trim();
    model = trimmed.toLowerCase() === "inherit" ? "inherit" : trimmed;
  }

  const skillsRaw = fm.skills;
  const skills = skillsRaw ? skillsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  const maxTurnsRaw = fm.maxturns;
  const maxTurns = maxTurnsRaw ? parseInt(maxTurnsRaw, 10) || undefined : undefined;

  const permissionMode = fm.permissionmode as Mode | undefined;
  const memory = fm.memory as AgentMemoryScope | undefined;
  const background = fm.background === "true" || fm.background === "true";
  const isolation = fm.isolation === "worktree" ? "worktree" as const : undefined;
  const color = fm.color || undefined;
  const omitClaudeMd = fm.omitclaudemd === "true";
  const initialPrompt = fm.initialprompt || undefined;

  const hooks = fmRaw.hooks as AgentHooks | undefined;
  const mcpServers = fmRaw.mcpServers as AgentMcpServerSpec[] | undefined;

  const systemPrompt = body;

  return {
    agentType: name,
    whenToUse: fm.description ?? "",
    ...(tools !== undefined ? { tools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(hooks ? { hooks } : {}),
    ...(memory ? { memory } : {}),
    ...(background ? { background } : {}),
    ...(isolation ? { isolation } : {}),
    ...(color ? { color } : {}),
    ...(omitClaudeMd ? { omitClaudeMd } : {}),
    ...(initialPrompt ? { initialPrompt } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    getSystemPrompt: () => systemPrompt,
    source,
    filename,
  };
}

export async function loadAgentDefsFrom(dir: string, source: AgentSource = "userSettings"): Promise<CustomAgentDef[]> {
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return []; }
  const out: CustomAgentDef[] = [];
  for (const f of names) {
    if (!f.endsWith(".md")) continue;
    const raw = await fs.readFile(path.join(dir, f), "utf8").catch(() => "");
    const def = parseAgentDef(f.slice(0, -3), raw, source);
    if (def) out.push(def);
  }
  return out;
}

export async function loadAgentDefs(
  projectDir: string,
  userDir: string,
  pluginDirs: string[] = [],
): Promise<AgentDef[]> {
  const plugins = (await Promise.all(pluginDirs.map((d) => loadAgentDefsFrom(d, "plugin")))).flat();
  const [user, project] = await Promise.all([
    loadAgentDefsFrom(userDir, "userSettings"),
    loadAgentDefsFrom(projectDir, "projectSettings"),
  ]);
  const byName = new Map<string, AgentDef>();
  for (const d of plugins) byName.set(d.agentType, d);
  for (const d of user) byName.set(d.agentType, d);
  for (const d of project) byName.set(d.agentType, d);
  return [...byName.values()];
}

// 判断 agent 是否内置
export function isBuiltInAgent(agent: AgentDef): agent is BuiltInAgentDef {
  return agent.source === "built-in";
}
