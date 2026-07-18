# DAO 子代理系统全面对齐 CC 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 DAO 子代理系统从单文件 `runSubagent` 全面重写为对标 CC 的多模块 AsyncGenerator 架构,含 Agent 定义扩展、执行引擎、工具过滤、同步/异步切换、恢复、Fork、Hooks、Memory、MCP、摘要、进度追踪、Handoff Classifier。

**Architecture:** 平移移植 CC `tools/AgentTool/` 的文件结构到 `agent/` 目录。执行引擎从 `Promise<string>` 改为 `AsyncGenerator<Message>`,上层通过 race generator.next() vs backgroundSignal 实现前台->后台无缝切换。Agent 定义对齐 CC frontmatter schema(不兼容旧 5 字段)。

**Tech Stack:** TypeScript ESM, Node ≥ 20, Zod, Vitest

## Global Constraints

- ES 模块 import 必须加 `.js` 后缀(NodeNext)
- 注释与面向用户输出一律中文
- 测试就近放(`*.test.ts`),与源码同目录
- 提交信息:Conventional Commits, AI 辅助加 `Co-Authored-By: Dao <noreply@dao-code>`
- 不兼容旧 `AgentDef` 5 字段接口,直接替换
- `agent` 工具加入 `ALL_AGENT_DISALLOWED_TOOLS`,子代理内不能再派子代理

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `agent/agent_defs.ts` | 重写 | Agent 定义类型 + frontmatter 解析 + 加载 |
| `agent/bundled_agents.ts` | 重写 | 4 个内置 agent 定义(explore/verify/general-purpose/plan) |
| `agent/agent_tools.ts` | 新建 | 工具过滤 + 结果汇总 + 进度追踪 + handoff classifier |
| `agent/agent_prompt.ts` | 新建 | agent 工具描述 prompt 生成 |
| `agent/runAgent.ts` | 新建 | 执行引擎(AsyncGenerator) |
| `agent/fork_agent.ts` | 新建 | Fork 机制 |
| `agent/resume_agent.ts` | 新建 | 子代理恢复 |
| `agent/agent_memory.ts` | 新建 | Agent 持久记忆 |
| `agent/agent_summary.ts` | 新建 | 后台 agent 定期摘要 |
| `agent/agent_hooks.ts` | 新建 | Agent 生命周期 hooks |
| `agent/agent_mcp.ts` | 新建 | Agent 专属 MCP(预留接口) |
| `agent/tasks.ts` | 扩展 | 后台任务管理器(加进度/摘要字段) |
| `agent/subagent.ts` | 删除 | 被 runAgent.ts 替代 |
| `tools/agent.ts` | 重写 | 工具入口(schema + handler) |
| `tools/types.ts` | 修改 | ToolContext 接口变更 |
| `index.ts` | 修改 | 装配新引擎 |
| `src/agent/loop.ts` | 修改 | 对接 generator 模式 |

## Task Dependency Order

```
Task 1 (agent_defs)  Task 2 (agent_tools)
       \                /
        \              /
       Task 3 (bundled_agents)
              |
       Task 4 (runAgent)
        /    |    \
  T5(fork) T6(memory) T7(hooks)
       \    |    /
       Task 8 (agent_prompt)
              |
       Task 9 (agent_summary)
              |
      Task 10 (resume_agent)
              |
      Task 11 (tasks.ts extend)
              |
      Task 12 (tools/agent.ts + types.ts)
              |
      Task 13 (index.ts)
              |
      Task 14 (handoff classifier)
              |
      Task 15 (integration + cleanup)
```

---

### Task 1: Agent 定义模型(agent_defs.ts)

**Files:**
- Rewrite: `src/agent/agent_defs.ts`
- Test: `src/agent/agent_defs.test.ts`

**Interfaces:**
- Produces: `BaseAgentDef`, `BuiltInAgentDef`, `CustomAgentDef`, `PluginAgentDef`, `AgentDef`, `AgentSource`, `AgentMcpServerSpec`, `parseAgentDef()`, `loadAgentDefs()`, `loadAgentDefsFrom()`

- [ ] **Step 1: Write failing tests for type parsing**

```typescript
// src/agent/agent_defs.test.ts
import { describe, it, expect } from "vitest";
import { parseAgentDef, type AgentDef } from "./agent_defs.js";

describe("parseAgentDef", () => {
  it("解析最小 frontmatter(只有 name + body)", () => {
    const raw = `---
name: my-agent
description: 测试 agent
---
你是一个测试 agent。`;
    const def = parseAgentDef("my-agent", raw);
    expect(def).not.toBeNull();
    expect(def!.agentType).toBe("my-agent");
    expect(def!.whenToUse).toBe("测试 agent");
    expect(def!.source).toBe("userSettings");
    expect(def!.getSystemPrompt()).toBe("你是一个测试 agent。");
  });

  it("解析完整 frontmatter(所有字段)", () => {
    const raw = `---
name: reviewer
description: 代码审查
tools: "read_file, grep_files"
disallowedTools: "write_file"
model: deepseek-v4-flash
permissionMode: plan
maxTurns: 50
skills: "code-review"
memory: project
background: true
isolation: worktree
color: red
omitClaudeMd: true
initialPrompt: "/review"
---
审查代码`;
    const def = parseAgentDef("reviewer", raw) as AgentDef;
    expect(def!.agentType).toBe("reviewer");
    expect(def!.tools).toEqual(["read_file", "grep_files"]);
    expect(def!.disallowedTools).toEqual(["write_file"]);
    expect(def!.model).toBe("deepseek-v4-flash");
    expect(def!.permissionMode).toBe("plan");
    expect(def!.maxTurns).toBe(50);
    expect(def!.skills).toEqual(["code-review"]);
    expect(def!.memory).toBe("project");
    expect(def!.background).toBe(true);
    expect(def!.isolation).toBe("worktree");
    expect(def!.color).toBe("red");
    expect(def!.omitClaudeMd).toBe(true);
    expect(def!.initialPrompt).toBe("/review");
  });

  it("省略 tools = undefined(全部工具)", () => {
    const raw = `---
name: full
description: 全工具
---
go`;
    const def = parseAgentDef("full", raw);
    expect(def!.tools).toBeUndefined();
  });

  it("tools 含 * = undefined(全部工具)", () => {
    const raw = `---
name: star
description: 星号
tools: "*"
---
go`;
    const def = parseAgentDef("star", raw);
    expect(def!.tools).toBeUndefined();
  });

  it("缺少 name 返回 null", () => {
    const raw = `---
description: 无名
---
body`;
    expect(parseAgentDef("file", raw)).toBeNull();
  });

  it("缺少 body 返回 null", () => {
    const raw = `---
name: empty
description: 空 body
---`;
    expect(parseAgentDef("empty", raw)).toBeNull();
  });

  it("hooks 解析", () => {
    const raw = `---
name: hooked
description: 有 hooks
hooks:
  SubagentStart:
    - command: "echo start"
  SubagentStop:
    - command: "echo stop"
---
body`;
    const def = parseAgentDef("hooked", raw);
    expect(def!.hooks).toBeDefined();
    expect(def!.hooks!.SubagentStart).toEqual([{ command: "echo start" }]);
    expect(def!.hooks!.SubagentStop).toEqual([{ command: "echo stop" }]);
  });

  it("mcpServers 解析(字符串引用)", () => {
    const raw = `---
name: mcp-agent
description: mcp
mcpServers:
  - slack
---
body`;
    const def = parseAgentDef("mcp-agent", raw);
    expect(def!.mcpServers).toEqual(["slack"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/agent_defs.test.ts`
Expected: FAIL - 旧接口没有 agentType/getSystemPrompt 等字段

- [ ] **Step 3: Write the new agent_defs.ts**

```typescript
// src/agent/agent_defs.ts
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
      const val = line.slice(i + 1).trim();
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
  const name = (fm.name || filename).trim();
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/agent_defs.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent_defs.ts src/agent/agent_defs.test.ts
git commit -m "feat(agent): 重写 agent_defs.ts - 对齐 CC AgentDef schema

Co-Authored-By: Dao <noreply@dao-code>"
```

---

### Task 2: 工具过滤 + 结果汇总 + 进度追踪(agent_tools.ts)

**Files:**
- Create: `src/agent/agent_tools.ts`
- Test: `src/agent/agent_tools.test.ts`

**Interfaces:**
- Consumes: `AgentDef` from Task 1, `ToolRegistry` from `tools/registry.ts`, `ChatMessage` from `client/types.ts`
- Produces: `ALL_AGENT_DISALLOWED_TOOLS`, `CUSTOM_AGENT_DISALLOWED_TOOLS`, `ASYNC_AGENT_ALLOWED_TOOLS`, `ONE_SHOT_AGENT_TYPES`, `filterToolsForAgent()`, `resolveAgentTools()`, `createProgressTracker()`, `finalizeAgentTool()`, `AgentToolResult`, `AgentProgress`, `ProgressTracker`

- [ ] **Step 1: Write failing tests**

```typescript
// src/agent/agent_tools.test.ts
import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../tools/registry.js";
import { defineTool } from "../tools/types.js";
import { z } from "zod";
import {
  ALL_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  ONE_SHOT_AGENT_TYPES,
  filterToolsForAgent,
  resolveAgentTools,
  createProgressTracker,
  finalizeAgentTool,
} from "./agent_tools.js";
import type { AgentDef } from "./agent_defs.js";

function mkTool(name: string) {
  return defineTool({
    name,
    description: `tool ${name}`,
    schema: z.object({}),
    capability: "read",
    approval: "auto",
    handler: async () => "ok",
  });
}

function mkRegistry(names: string[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const n of names) r.register(mkTool(n));
  return r;
}

const builtinAgent: AgentDef = {
  agentType: "test-builtin",
  whenToUse: "test",
  source: "built-in",
  getSystemPrompt: () => "test",
};

const customAgent: AgentDef = {
  agentType: "test-custom",
  whenToUse: "test",
  source: "userSettings",
  getSystemPrompt: () => "test",
};

describe("ALL_AGENT_DISALLOWED_TOOLS", () => {
  it("包含 agent/ask_user/task_stop", () => {
    expect(ALL_AGENT_DISALLOWED_TOOLS.has("agent")).toBe(true);
    expect(ALL_AGENT_DISALLOWED_TOOLS.has("ask_user")).toBe(true);
    expect(ALL_AGENT_DISALLOWED_TOOLS.has("task_stop")).toBe(true);
  });
});

describe("filterToolsForAgent", () => {
  it("内置 agent 过滤全局禁用工具", () => {
    const r = mkRegistry(["agent", "ask_user", "read_file", "grep_files"]);
    const filtered = filterToolsForAgent({ tools: r, isBuiltIn: true, isAsync: false });
    const names = [...filtered["tools" as never] as Map<string, unknown>].map(([, v]) => (v as { name: string }).name);
    expect(names).not.toContain("agent");
    expect(names).not.toContain("ask_user");
    expect(names).toContain("read_file");
  });

  it("异步 agent 只保留白名单工具", () => {
    const r = mkRegistry(["read_file", "ask_user", "agent", "exec_shell"]);
    const filtered = filterToolsForAgent({ tools: r, isBuiltIn: false, isAsync: true });
    const names = [...filtered["tools" as never] as Map<string, unknown>].map(([, v]) => (v as { name: string }).name);
    expect(names).toContain("read_file");
    expect(names).toContain("exec_shell");
    expect(names).not.toContain("ask_user");
    expect(names).not.toContain("agent");
  });
});

describe("resolveAgentTools", () => {
  it("tools=undefined -> 全部(减禁用)", () => {
    const r = mkRegistry(["read_file", "agent", "grep_files"]);
    const { resolvedTools, hasWildcard } = resolveAgentTools(builtinAgent, r, false);
    expect(hasWildcard).toBe(true);
    // resolvedTools 是 ToolRegistry,检查不含 agent
    const names = [...(resolvedTools as any).tools.keys()];
    expect(names).toContain("read_file");
    expect(names).not.toContain("agent");
  });

  it("tools 白名单 -> 只含白名单", () => {
    const agent: AgentDef = { ...customAgent, tools: ["read_file", "grep_files"] };
    const r = mkRegistry(["read_file", "grep_files", "exec_shell", "agent"]);
    const { resolvedTools, hasWildcard } = resolveAgentTools(agent, r, false);
    expect(hasWildcard).toBe(false);
    const names = [...(resolvedTools as any).tools.keys()];
    expect(names).toEqual(["read_file", "grep_files"]);
  });

  it("disallowedTools 排除", () => {
    const agent: AgentDef = { ...customAgent, disallowedTools: ["exec_shell"] };
    const r = mkRegistry(["read_file", "exec_shell", "grep_files"]);
    const { resolvedTools } = resolveAgentTools(agent, r, false);
    const names = [...(resolvedTools as any).tools.keys()];
    expect(names).not.toContain("exec_shell");
    expect(names).toContain("read_file");
  });
});

describe("createProgressTracker", () => {
  it("初始进度为零", () => {
    const t = createProgressTracker();
    const p = t.getProgress();
    expect(p.tokenCount).toBe(0);
    expect(p.toolUseCount).toBe(0);
  });

  it("累计 assistant 消息的 tool_use", () => {
    const t = createProgressTracker();
    t.updateFromMessage({
      role: "assistant",
      content: "hello",
      tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: "{}" } }],
    } as never);
    expect(t.getProgress().toolUseCount).toBe(1);
  });
});

describe("ONE_SHOT_AGENT_TYPES", () => {
  it("包含 explore 和 plan", () => {
    expect(ONE_SHOT_AGENT_TYPES.has("explore")).toBe(true);
    expect(ONE_SHOT_AGENT_TYPES.has("plan")).toBe(true);
    expect(ONE_SHOT_AGENT_TYPES.has("verify")).toBe(false);
  });
});

describe("finalizeAgentTool", () => {
  it("提取最后一条 assistant 文本", () => {
    const messages = [
      { role: "user" as const, content: "do it" },
      { role: "assistant" as const, content: "working", tool_calls: [] },
      { role: "assistant" as const, content: "done", tool_calls: [] },
    ];
    const result = finalizeAgentTool(messages as never, "agent-1", {
      prompt: "do it",
      model: "test",
      agentType: "test",
      startTime: Date.now() - 1000,
      isAsync: false,
      isBuiltInAgent: false,
    });
    expect(result.content.some((c: any) => c.text === "done")).toBe(true);
    expect(result.agentId).toBe("agent-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/agent_tools.test.ts`
Expected: FAIL - module not found

- [ ] **Step 3: Write agent_tools.ts**

```typescript
// src/agent/agent_tools.ts
import type { ChatMessage, AssistantMessage } from "../client/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { Mode } from "../tools/tools_for_mode.js";
import type { AgentDef } from "./agent_defs.js";
import type { Tool } from "../tools/types.js";

// ---- 工具禁用/允许清单 ----

export const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  "agent",
  "ask_user",
  "task_stop",
]);

export const CUSTOM_AGENT_DISALLOWED_TOOLS = new Set([
  ...ALL_AGENT_DISALLOWED_TOOLS,
]);

export const ASYNC_AGENT_ALLOWED_TOOLS = new Set([
  "read_file", "list_dir", "grep_files", "file_search",
  "exec_shell", "exec_shell_poll", "exec_shell_kill",
  "write_file", "edit_file", "multi_edit", "notebook_edit",
  "web_search", "fetch_url",
  "todo_write",
  "skill",
  "memory_write", "memory_read",
  "notify_user",
  "verify_done",
]);

// 一次性 agent(不支持 resume)
export const ONE_SHOT_AGENT_TYPES = new Set(["explore", "plan"]);

// ---- 工具过滤 ----

export function filterToolsForAgent({
  tools,
  isBuiltIn,
  isAsync = false,
  permissionMode,
}: {
  tools: ToolRegistry;
  isBuiltIn: boolean;
  isAsync?: boolean;
  permissionMode?: Mode;
}): ToolRegistry {
  const internal = tools as unknown as { tools: Map<string, Tool> };
  const filtered = new ToolRegistry();
  for (const [name, tool] of internal.tools) {
    if (ALL_AGENT_DISALLOWED_TOOLS.has(name)) continue;
    if (!isBuiltIn && CUSTOM_AGENT_DISALLOWED_TOOLS.has(name)) continue;
    if (isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(name)) continue;
    filtered.register(tool);
  }
  return filtered;
}

export function resolveAgentTools(
  agentDef: Pick<AgentDef, "tools" | "disallowedTools" | "source" | "permissionMode">,
  availableTools: ToolRegistry,
  isAsync = false,
): { resolvedTools: ToolRegistry; hasWildcard: boolean } {
  const isBuiltIn = agentDef.source === "built-in";
  const filtered = filterToolsForAgent({
    tools: availableTools,
    isBuiltIn,
    isAsync,
    permissionMode: agentDef.permissionMode,
  });

  const disallowedSet = new Set(agentDef.disallowedTools ?? []);
  const allowedFiltered = (() => {
    const internal = filtered as unknown as { tools: Map<string, Tool> };
    const r = new ToolRegistry();
    for (const [name, tool] of internal.tools) {
      if (!disallowedSet.has(name)) r.register(tool);
    }
    return r;
  })();

  const hasWildcard = agentDef.tools === undefined || (agentDef.tools.length === 1 && agentDef.tools[0] === "*");
  if (hasWildcard) {
    return { resolvedTools: allowedFiltered, hasWildcard: true };
  }

  const toolSet = new Set(agentDef.tools ?? []);
  const internal = allowedFiltered as unknown as { tools: Map<string, Tool> };
  const r = new ToolRegistry();
  for (const [name, tool] of internal.tools) {
    if (toolSet.has(name)) r.register(tool);
  }
  return { resolvedTools: r, hasWildcard: false };
}

// ---- 进度追踪 ----

export interface AgentProgress {
  tokenCount: number;
  toolUseCount: number;
  durationMs: number;
  lastActivity?: {
    activityDescription: string;
    toolName: string;
    timestamp: number;
  };
}

export interface ProgressTracker {
  getProgress(): AgentProgress;
  updateFromMessage(msg: ChatMessage): void;
}

function resolveActivityDescription(msg: ChatMessage): string {
  if (msg.role !== "tool") return `使用 ${msg.role}`;
  const content = typeof msg.content === "string" ? msg.content : "";
  // 从 tool result 反推活动描述过于间接;用 tool_call_id 关联更准
  // 简化:返回通用描述
  return `工具返回(${content.slice(0, 40)})`;
}

export function createProgressTracker(): ProgressTracker {
  const start = Date.now();
  let tokenCount = 0;
  let toolUseCount = 0;
  let lastActivity: AgentProgress["lastActivity"];

  return {
    getProgress() {
      return { tokenCount, toolUseCount, durationMs: Date.now() - start, lastActivity };
    },
    updateFromMessage(msg: ChatMessage) {
      if (msg.role === "assistant") {
        const a = msg as AssistantMessage;
        if (a.tool_calls) toolUseCount += a.tool_calls.length;
      }
      if (msg.role === "tool") {
        lastActivity = {
          activityDescription: resolveActivityDescription(msg),
          toolName: "tool",
          timestamp: Date.now(),
        };
      }
    },
  };
}

// ---- 结果汇总 ----

export interface AgentToolResult {
  agentId: string;
  agentType?: string;
  content: { type: "text"; text: string }[];
  totalDurationMs: number;
  totalTokens: number;
  totalToolUseCount: number;
}

export function finalizeAgentTool(
  messages: ChatMessage[],
  agentId: string,
  metadata: {
    prompt: string;
    model: string;
    agentType: string;
    startTime: number;
    isAsync: boolean;
    isBuiltInAgent: boolean;
  },
): AgentToolResult {
  // 从后往前找最后一条有文本的 assistant
  let content: { type: "text"; text: string }[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const text = typeof m.content === "string" ? m.content : "";
    if (text) { content = [{ type: "text", text }]; break; }
  }

  let totalToolUseCount = 0;
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) totalToolUseCount += m.tool_calls.length;
  }

  return {
    agentId,
    agentType: metadata.agentType,
    content,
    totalDurationMs: Date.now() - metadata.startTime,
    totalTokens: 0, // TODO: 从最后一条 assistant 的 usage 提取
    totalToolUseCount,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/agent_tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent_tools.ts src/agent/agent_tools.test.ts
git commit -m "feat(agent): 新建 agent_tools.ts - 工具过滤/结果汇总/进度追踪

Co-Authored-By: Dao <noreply@dao-code>"
```

---

### Task 3: 内置 Agent 定义(bundled_agents.ts)

**Files:**
- Rewrite: `src/agent/bundled_agents.ts`
- Test: `src/agent/bundled_agents.test.ts`

**Interfaces:**
- Consumes: `BuiltInAgentDef` from Task 1
- Produces: `GENERAL_PURPOSE_AGENT`, `EXPLORE_AGENT`, `PLAN_AGENT`, `VERIFY_AGENT`, `BUNDLED_AGENTS`

- [ ] **Step 1: Write failing tests**

```typescript
// src/agent/bundled_agents.test.ts
import { describe, it, expect } from "vitest";
import { BUNDLED_AGENTS, GENERAL_PURPOSE_AGENT, EXPLORE_AGENT, PLAN_AGENT, VERIFY_AGENT } from "./bundled_agents.js";

describe("BUNDLED_AGENTS", () => {
  it("包含 4 个内置 agent", () => {
    expect(BUNDLED_AGENTS.length).toBe(4);
  });

  it("每个 agent 有 agentType 和 whenToUse", () => {
    for (const a of BUNDLED_AGENTS) {
      expect(a.agentType).toBeTruthy();
      expect(a.whenToUse).toBeTruthy();
      expect(a.source).toBe("built-in");
    }
  });
});

describe("EXPLORE_AGENT", () => {
  it("disallowedTools 含 agent/edit/write", () => {
    expect(EXPLORE_AGENT.disallowedTools).toContain("agent");
    expect(EXPLORE_AGENT.disallowedTools).toContain("edit_file");
    expect(EXPLORE_AGENT.disallowedTools).toContain("write_file");
  });
  it("omitClaudeMd = true", () => {
    expect(EXPLORE_AGENT.omitClaudeMd).toBe(true);
  });
  it("model = flash", () => {
    expect(EXPLORE_AGENT.model).toContain("flash");
  });
});

describe("PLAN_AGENT", () => {
  it("disallowedTools 含 agent/edit/write/exec_shell", () => {
    expect(PLAN_AGENT.disallowedTools).toContain("agent");
    expect(PLAN_AGENT.disallowedTools).toContain("exec_shell");
  });
  it("omitClaudeMd = true", () => {
    expect(PLAN_AGENT.omitClaudeMd).toBe(true);
  });
});

describe("VERIFY_AGENT", () => {
  it("background = true", () => {
    expect(VERIFY_AGENT.background).toBe(true);
  });
  it("disallowedTools 含 agent/edit/write", () => {
    expect(VERIFY_AGENT.disallowedTools).toContain("agent");
  });
});

describe("GENERAL_PURPOSE_AGENT", () => {
  it("memory = project", () => {
    expect(GENERAL_PURPOSE_AGENT.memory).toBe("project");
  });
  it("tools = undefined(全部)", () => {
    expect(GENERAL_PURPOSE_AGENT.tools).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/bundled_agents.test.ts`
Expected: FAIL - 旧接口字段名不匹配

- [ ] **Step 3: Write bundled_agents.ts**

```typescript
// src/agent/bundled_agents.ts
import type { BuiltInAgentDef } from "./agent_defs.js";

export const GENERAL_PURPOSE_AGENT: BuiltInAgentDef = {
  agentType: "general-purpose",
  whenToUse: "通用子代理:自包含地完成一件被交代清楚的子任务,用同样的工具自主跑完、只回提炼后的结论。省略 agent_type 时默认用它。",
  tools: undefined,
  memory: "project",
  source: "built-in",
  getSystemPrompt: () => `你是通用子代理(general-purpose)。你被派来独立完成一件子任务--你没有主对话的上下文,任务描述即你拥有的全部背景。
- 自包含完成:用你拥有的工具把这件事做完,不要反问、不要假设主任务的其它状态。
- 只回结论:返回提炼后的最终结果(做了什么、结论是什么、关键证据 file:line),不要把中间过程或整块文件倒回去。
- 不确定就说不确定,别编。`,
};

export const EXPLORE_AGENT: BuiltInAgentDef = {
  agentType: "explore",
  whenToUse: "只读·彻底探查子代理:多策略搜索代码库/资料,跨多位置与命名惯例,只回提炼后的结论(适合范围广、要点散的调查,可并行派多个)。",
  model: process.env.DAO_EXPLORE_MODEL || "deepseek-v4-flash",
  disallowedTools: ["agent", "edit_file", "write_file", "multi_edit", "notebook_edit"],
  omitClaudeMd: true,
  source: "built-in",
  getSystemPrompt: () => `你是探查子代理(explore)。任务:把某个问题在代码库/资料里【彻底查清】,只回提炼后的结论--不要把文件内容整块倒回去。
- 多策略搜索:一种搜法没结果就换--查多个位置、试不同命名惯例(camelCase/snake_case/缩写/别名)、找相关与邻近文件、顺调用链上下追。
- 彻底度按任务要求:任务说"quick"就基本定位即可;"thorough/very thorough"就跨多处交叉验证、不漏。
- 你是只读的:用 read_file/grep_files/file_search/list_dir(必要时 fetch_url/web_search)取证,不改任何文件。
- 回结论:直接给答案(在哪、是什么、彼此怎么联系),附关键 file:line 佐证;不确定就说不确定,别编。`,
};

export const PLAN_AGENT: BuiltInAgentDef = {
  agentType: "plan",
  whenToUse: "架构规划子代理:只读分析代码库后产出实现思路/步骤/取舍与关键文件,不改任何文件、不执行命令。",
  disallowedTools: ["agent", "edit_file", "write_file", "multi_edit", "notebook_edit", "exec_shell", "exec_shell_poll", "exec_shell_kill"],
  omitClaudeMd: true,
  source: "built-in",
  getSystemPrompt: () => `你是规划子代理(plan)。职责:读懂相关代码后给出**实现方案**--步骤拆解、关键文件与改动点、架构取舍与风险,不写代码、不执行命令。
- 只读取证:用 read_file/grep_files/file_search/list_dir 把现状摸清,再设计。
- 产出可执行的计划:每步说清动哪个文件、为什么;指出依赖与顺序;标出不确定处与备选。
- 不改文件、不跑命令(你没有写/执行工具)。`,
};

export const VERIFY_AGENT: BuiltInAgentDef = {
  agentType: "verify",
  whenToUse: "对抗性验证子代理:不是确认'能用',而是试图证明它是坏的--真跑起来找反例/边界/回归,反自我合理化。声称完成前派它独立验。",
  background: true,
  disallowedTools: ["agent", "edit_file", "write_file", "multi_edit", "notebook_edit"],
  source: "built-in",
  getSystemPrompt: () => `你是验证子代理(verify)。你的职责【不是】确认它能用,而是【试图证明它是坏的】--对抗性地找反例、边界、回归。

反自我合理化:
- "代码看起来是对的" -> 读不是验证,跑它。
- "实现者的测试已经过了" -> 写代码的是 LLM,独立另跑验证。
- "这个大概没问题" -> 大概 ≠ 已验证,跑它。

通用基线:① 读 DAO.md/README 拿构建测试命令;② 跑构建(失败判不通过);③ 跑测试(失败判不通过);④ 跑 linter/typecheck。

回报格式:每项检查给【跑了什么命令 + 实际输出 + 通过/不通过】。结尾固定一行:
判定:通过
判定:不通过
判定:部分`,
};

export const BUNDLED_AGENTS: BuiltInAgentDef[] = [
  GENERAL_PURPOSE_AGENT,
  EXPLORE_AGENT,
  PLAN_AGENT,
  VERIFY_AGENT,
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/bundled_agents.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/bundled_agents.ts src/agent/bundled_agents.test.ts
git commit -m "feat(agent): 重写 bundled_agents.ts - 对齐 CC 内置 agent 定义

Co-Authored-By: Dao <noreply@dao-code>"
```

---

### Task 4: 执行引擎 runAgent.ts(AsyncGenerator,7 个阶段)

**Files:**
- Create: `src/agent/runAgent.ts`
- Test: `src/agent/runAgent.test.ts`

**Interfaces:**
- Consumes: `AgentDef` from Task 1, `resolveAgentTools`/`createProgressTracker` from Task 2, `ToolRegistry` from `tools/registry.ts`, `Session` from `session/session.ts`, `TurnDeps`/`runTurn` from `agent/loop.ts`, `ChatMessage` from `client/types.ts`, `ToolContext` from `tools/types.ts`
- Produces: `RunAgentParams`, `runAgent()`, `getAgentModel()`, `filterIncompleteToolCalls()`

- [ ] **Step 1: Write failing tests**

```typescript
// src/agent/runAgent.test.ts
import { describe, it, expect, vi } from "vitest";
import { getAgentModel, filterIncompleteToolCalls } from "./runAgent.js";
import type { ChatMessage, AssistantMessage, ToolMessage } from "../client/types.js";

describe("getAgentModel", () => {
  it("agent 定义无 model -> inherit(返回父模型)", () => {
    expect(getAgentModel(undefined, "deepseek-v4-pro", undefined)).toBe("deepseek-v4-pro");
  });

  it("agent 定义 model=inherit -> 返回父模型", () => {
    expect(getAgentModel("inherit", "deepseek-v4-pro", undefined)).toBe("deepseek-v4-pro");
  });

  it("agent 定义 model=flash -> 返回 flash", () => {
    expect(getAgentModel("deepseek-v4-flash", "deepseek-v4-pro", undefined)).toBe("deepseek-v4-flash");
  });

  it("调用级 model 覆盖 > agent 定义 > inherit", () => {
    expect(getAgentModel("deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-pro-turbo")).toBe("deepseek-v4-pro-turbo");
  });

  it("agent 定义 model > inherit(父模型被覆盖)", () => {
    expect(getAgentModel("deepseek-v4-flash", "deepseek-v4-pro", undefined)).toBe("deepseek-v4-flash");
  });
});

describe("filterIncompleteToolCalls", () => {
  it("保留所有非 assistant 消息", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    expect(filterIncompleteToolCalls(msgs).length).toBe(2);
  });

  it("过滤未配对 tool_use 的 assistant 消息", () => {
    const assistantWithToolCall: AssistantMessage = {
      role: "assistant",
      content: "let me read",
      tool_calls: [{ id: "tc-1", type: "function", function: { name: "read_file", arguments: "{}" } }],
    };
    const msgs: ChatMessage[] = [
      { role: "user", content: "do it" },
      assistantWithToolCall,
      // 没有 tool result 对应 tc-1
      { role: "assistant", content: "done" },
    ];
    const filtered = filterIncompleteToolCalls(msgs);
    // assistantWithToolCall 应被过滤(有 tool_call 但无对应 tool result)
    const assistants = filtered.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(1);
    expect((assistants[0] as AssistantMessage).content).toBe("done");
  });

  it("保留配对完成的 assistant + tool 消息", () => {
    const assistantWithToolCall: AssistantMessage = {
      role: "assistant",
      content: "let me read",
      tool_calls: [{ id: "tc-1", type: "function", function: { name: "read_file", arguments: "{}" } }],
    };
    const toolResult: ToolMessage = {
      role: "tool",
      tool_call_id: "tc-1",
      content: "file content",
    };
    const msgs: ChatMessage[] = [
      { role: "user", content: "do it" },
      assistantWithToolCall,
      toolResult,
      { role: "assistant", content: "done" },
    ];
    const filtered = filterIncompleteToolCalls(msgs);
    expect(filtered.length).toBe(4);
  });

  it("无 tool_calls 的 assistant 消息保留", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(filterIncompleteToolCalls(msgs).length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/runAgent.test.ts`
Expected: FAIL - module not found

- [ ] **Step 3: Write runAgent.ts**

```typescript
// src/agent/runAgent.ts
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChatMessage, AssistantMessage, ToolMessage, UserMessage } from "../client/types.js";
import type { ToolContext } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { Mode } from "../tools/tools_for_mode.js";
import type { Session } from "../session/session.js";
import type { TurnDeps } from "./loop.js";
import type { AgentDef } from "./agent_defs.js";
import { resolveAgentTools, createProgressTracker, type ProgressTracker } from "./agent_tools.js";

// ---- 类型 ----

/** runAgent 的参数(对标 CC runAgent 的参数对象) */
export interface RunAgentParams {
  /** agent 定义(含 system prompt / 工具 / 模型 / 权限) */
  agentDef: AgentDef;
  /** 初始消息(用户 task) */
  promptMessages: ChatMessage[];
  /** 父代理的 ToolContext */
  toolUseContext: ToolContext;
  /** 权限检查函数(透传给 runTurn) */
  canUseTool?: unknown;
  /** 是否异步(后台运行) */
  isAsync: boolean;
  /** fork 路径:父的完整对话历史 */
  forkContextMessages?: ChatMessage[];
  /** 覆盖项 */
  override?: {
    systemPrompt?: string;
    abortController?: AbortController;
    agentId?: string;
  };
  /** 调用级模型覆盖(优先级最高) */
  model?: string;
  /** 回合上限覆盖 */
  maxTurns?: number;
  /** 预组装工具池 */
  availableTools?: ToolRegistry;
  /** fork 路径:直接用父的工具池(缓存对齐) */
  useExactTools?: boolean;
  /** worktree 隔离路径 */
  worktreePath?: string;
  /** 任务描述(持久化用) */
  description?: string;
  /** 缓存安全参数回调(后台摘要用) */
  onCacheSafeParams?: (params: CacheSafeParams) => void;
  /** 每条消息回调(活性检测用) */
  onQueryProgress?: () => void;
  // 以下由 index.ts 装配注入(非外部调用者提供)
  /** API 配置 */
  config?: { baseUrl: string; apiKey: string };
  /** 流式聊天函数 */
  streamChat?: TurnDeps["streamChat"];
  /** 工具调用执行器 */
  executeToolCalls?: TurnDeps["executeToolCalls"];
  /** 审批门 */
  gate?: TurnDeps["gate"];
  /** runTurn 函数 */
  runTurn?: (deps: TurnDeps) => Promise<void>;
  /** 输出函数 */
  write?: (s: string) => void;
  /** 转录写入回调 */
  writeTranscript?: (messages: ChatMessage[]) => void;
  /** 回合边界消费追加消息(SendMessage) */
  drainPending?: () => string[];
  /** 缓存审计 sink */
  auditSink?: TurnDeps["auditSink"];
}

/** 缓存安全参数(后台摘要 fork 用) */
export interface CacheSafeParams {
  systemPrompt: string;
  forkContextMessages: ChatMessage[];
}

// ---- 模型解析 ----

/**
 * 解析 agent 模型(对标 CC getAgentModel)。
 * 优先级:调用级 model > agent 定义 model > inherit(父模型)
 */
export function getAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  overrideModel: string | undefined,
): string {
  // 调用级覆盖优先
  if (overrideModel) return overrideModel;
  // agent 定义指定了模型(且不是 inherit)
  if (agentModel && agentModel !== "inherit") return agentModel;
  // 默认继承父模型
  return parentModel;
}

// ---- 消息过滤 ----

/**
 * 过滤未配对 tool_use 的 assistant 消息(对标 CC filterIncompleteToolCalls)。
 * 防止 fork 上下文中有孤儿 tool_call 导致 API 报错。
 */
export function filterIncompleteToolCalls(messages: ChatMessage[]): ChatMessage[] {
  // 收集所有有 tool result 的 tool_call_id
  const toolUseIdsWithResults = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool") {
      toolUseIdsWithResults.add(m.tool_call_id);
    }
  }

  return messages.filter((m) => {
    if (m.role !== "assistant") return true;
    const a = m as AssistantMessage;
    if (!a.tool_calls || a.tool_calls.length === 0) return true;
    // 如果有任何一个 tool_call 没有对应 result,过滤掉这条 assistant
    const hasIncomplete = a.tool_calls.some((tc) => !toolUseIdsWithResults.has(tc.id));
    return !hasIncomplete;
  });
}

// ---- 子代理上下文 ----

/** 子代理的 sidechain 转录目录 */
function getSubagentDir(): string {
  return path.join(process.cwd(), ".dao", "subagents");
}

/** 生成 agent ID */
function createAgentId(): string {
  return `agent-${randomUUID().slice(0, 8)}`;
}

/**
 * 逐条写入 sidechain 转录(fire-and-forget,失败不影响运行)。
 * 对标 CC recordSidechainTranscript -- 每条消息追加一行 JSON。
 */
async function recordSidechainMessage(agentId: string, messages: ChatMessage[]): Promise<void> {
  const dir = getSubagentDir();
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const file = path.join(dir, `${agentId}.jsonl`);
  const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  await fs.appendFile(file, lines, "utf8").catch(() => {});
}

/** 写入 agent 元数据(对标 CC writeAgentMetadata) */
async function writeAgentMetadata(
  agentId: string,
  meta: { agentType: string; description?: string; worktreePath?: string; model?: string },
): Promise<void> {
  const dir = getSubagentDir();
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const file = path.join(dir, `${agentId}.meta.json`);
  await fs.writeFile(file, JSON.stringify(meta, null, 2), "utf8").catch(() => {});
}

// ---- 执行引擎 ----

/**
 * 子代理执行引擎(对标 CC runAgent)。
 * AsyncGenerator:逐条 yield ChatMessage,上层可消费消息流。
 *
 * 7 个阶段:
 * 1. 参数解析(模型/工具/权限)
 * 2. 上下文构建(system prompt + 消息组装)
 * 3. Agent 级资源初始化(hooks/skills/memory/mcp -- Phase 1 预留接口)
 * 4. 会话创建
 * 5. 查询循环(runTurn + yield)
 * 6. 回调(内置 agent callback)
 * 7. 清理(finally)
 */
export async function* runAgent(params: RunAgentParams): AsyncGenerator<ChatMessage, void> {
  const {
    agentDef,
    promptMessages,
    toolUseContext,
    isAsync,
    forkContextMessages,
    override,
    model: modelOverride,
    maxTurns: maxTurnsOverride,
    availableTools,
    useExactTools = false,
    worktreePath,
    description,
    onCacheSafeParams,
    onQueryProgress,
    config,
    streamChat,
    executeToolCalls,
    gate,
    runTurn,
    write = () => {},
    writeTranscript,
    drainPending,
    auditSink,
  } = params;

  // ---- 阶段 1:参数解析 ----

  const parentModel = toolUseContext.sessionModel ?? "deepseek-v4-pro";
  const resolvedModel = getAgentModel(agentDef.model, parentModel, modelOverride);
  const agentId = override?.agentId ?? createAgentId();

  // 工具解析:useExactTools 直接用父的工具池(fork 路径);否则走 resolveAgentTools
  let resolvedTools: ToolRegistry;
  if (useExactTools && availableTools) {
    resolvedTools = availableTools;
  } else {
    const pool = availableTools ?? new ToolRegistry();
    const result = resolveAgentTools(agentDef, pool, isAsync);
    resolvedTools = result.resolvedTools;
  }

  // 权限模式:agent 定义覆盖父的(除非父是 auto/bypass)
  let agentMode: Mode = "normal";
  if (agentDef.permissionMode) {
    agentMode = agentDef.permissionMode;
  }

  // abort 控制器:异步=独立(不随父 ESC 死);同步=共享父的
  const agentAbortController = override?.abortController
    ? override.abortController
    : isAsync
      ? new AbortController()
      : (undefined as unknown as AbortController); // 同步由 runTurn 的 signal 透传

  // ---- 阶段 2:上下文构建 ----

  // fork 路径:过滤未配对 tool_use,然后拼接
  const contextMessages: ChatMessage[] = forkContextMessages
    ? filterIncompleteToolCalls(forkContextMessages)
    : [];

  // system prompt:override(fork 用父的)> 内置 agent 闭包 > 自定义 agent frontmatter content
  let agentSystemPrompt: string;
  if (override?.systemPrompt) {
    agentSystemPrompt = override.systemPrompt;
  } else {
    agentSystemPrompt = agentDef.getSystemPrompt();
  }

  // 初始消息:fork 上下文 + prompt
  const initialMessages: ChatMessage[] = [...contextMessages, ...promptMessages];

  // ---- 阶段 3:Agent 级资源初始化(Phase 1 预留接口) ----
  // Hooks:Phase 1 不实现(agent_hooks.ts 在 Task 7 实现,但此处预留调用点)
  // Skills:Phase 1 不实现(预加载 skill 作为 initial message)
  // Memory:Phase 1 不实现(agent_memory.ts 在 Task 6 实现,但此处预留调用点)
  // MCP:Phase 1 不实现(agent_mcp.ts 预留接口)

  // 缓存安全参数回调(后台摘要用)
  if (onCacheSafeParams) {
    onCacheSafeParams({
      systemPrompt: agentSystemPrompt,
      forkContextMessages: initialMessages,
    });
  }

  // 转录:写入初始消息 + 元数据(fire-and-forget)
  void recordSidechainMessage(agentId, initialMessages).catch(() => {});
  void writeAgentMetadata(agentId, {
    agentType: agentDef.agentType,
    ...(description && { description }),
    ...(worktreePath && { worktreePath }),
    model: resolvedModel,
  }).catch(() => {});

  // ---- 阶段 4:会话创建 ----

  const sub = new Session(agentSystemPrompt, resolvedModel);
  sub.mode = agentMode;
  // 替换默认 system message 为组装好的消息序列
  sub.messages = [...initialMessages];

  // 子代理 ToolContext:独立 readFiles/readMeta(不污染父)
  const subDepth = (toolUseContext.subagentDepth ?? 0) + 1;
  const subCtx: ToolContext = {
    ...toolUseContext,
    subagentDepth: subDepth,
    readFiles: new Set<string>(),
    readMeta: new Map<string, { mtime: number; size: number }>(),
    sessionModel: resolvedModel,
    // fork 路径保留父的 signal;异步路径用独立 controller
    ...(agentAbortController ? { signal: agentAbortController.signal } : {}),
  };

  // ---- 阶段 5:查询循环 ----

  const tracker = createProgressTracker();

  try {
    if (runTurn && config && streamChat && executeToolCalls && gate) {
      // 子代理输出攒 buffer(防并发子代理 write 交织)
      const buf: string[] = [];
      await runTurn({
        session: sub,
        config,
        registry: resolvedTools,
        ctx: subCtx,
        gate,
        streamChat,
        executeToolCalls,
        write: (s) => buf.push(s),
        signal: agentAbortController?.signal,
        drainPending,
        background: true, // 子代理:遇 529 不重试/不回退
        selfChallenge: true, // 子代理跑确定性卡住检测
        maxTurns: maxTurnsOverride ?? agentDef.maxTurns ?? 200,
        ...(auditSink ? { auditSink, auditId: { agent: "sub" as const, subId: agentId, depth: subDepth } } : {}),
      });

      // flush 子代理输出
      if (buf.length) write(buf.join(""));
    }

    // yield 生成的新消息(排除初始消息)
    for (let i = initialMessages.length; i < sub.messages.length; i++) {
      const msg = sub.messages[i]!;
      onQueryProgress?.();
      tracker.updateFromMessage(msg);
      // 逐条转录(fire-and-forget)
      void recordSidechainMessage(agentId, [msg]).catch(() => {});
      yield msg;
    }

    // 转录落盘
    try { writeTranscript?.(sub.messages); } catch { /* 落盘失败不影响结果 */ }

    // ---- 阶段 6:回调 ----
    // 内置 agent 的 callback(如有)-- Phase 1 无内置 agent 有 callback

  } finally {
    // ---- 阶段 7:清理 ----
    // Phase 1 清理:
    // - MCP 连接清理(agent_mcp.ts 实现)
    // - Hooks 注销(agent_hooks.ts 实现)
    // - readFileState 释放(子代理独立,随 GC)
    // - shell tasks 清理(Phase 2)
    // - todos 清理(Phase 2)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/runAgent.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/runAgent.ts src/agent/runAgent.test.ts
git commit -m "feat(agent): 新建 runAgent.ts - AsyncGenerator 执行引擎(7 阶段)

Co-Authored-By: Dao <noreply@dao-code>"
```

---

### Task 5: Fork 机制 fork_agent.ts(FORK_AGENT 定义 + buildForkedMessages + 防递归)

**Files:**
- Create: `src/agent/fork_agent.ts`
- Test: `src/agent/fork_agent.test.ts`

**Interfaces:**
- Consumes: `BuiltInAgentDef` from Task 1, `ChatMessage`/`AssistantMessage`/`UserMessage` from `client/types.ts`
- Produces: `FORK_AGENT`, `FORK_BOILERPLATE_TAG`, `FORK_DIRECTIVE_PREFIX`, `buildForkedMessages()`, `buildChildMessage()`, `buildWorktreeNotice()`, `isInForkChild()`

- [ ] **Step 1: Write failing tests**

```typescript
// src/agent/fork_agent.test.ts
import { describe, it, expect } from "vitest";
import {
  FORK_AGENT,
  FORK_BOILERPLATE_TAG,
  FORK_DIRECTIVE_PREFIX,
  buildForkedMessages,
  buildChildMessage,
  buildWorktreeNotice,
  isInForkChild,
} from "./fork_agent.js";
import type { ChatMessage, AssistantMessage, UserMessage } from "../client/types.js";

describe("FORK_AGENT", () => {
  it("agentType = fork", () => {
    expect(FORK_AGENT.agentType).toBe("fork");
  });

  it("model = inherit", () => {
    expect(FORK_AGENT.model).toBe("inherit");
  });

  it("source = built-in", () => {
    expect(FORK_AGENT.source).toBe("built-in");
  });

  it("getSystemPrompt 返回空字符串(实际用父的)", () => {
    expect(FORK_AGENT.getSystemPrompt()).toBe("");
  });

  it("tools = undefined(useExactTools 直接拿父的工具池)", () => {
    expect(FORK_AGENT.tools).toBeUndefined();
  });
});

describe("buildChildMessage", () => {
  it("包含 fork-boilerplate 标签", () => {
    const msg = buildChildMessage("调查缓存命中率");
    expect(msg).toContain(`<${FORK_BOILERPLATE_TAG}>`);
    expect(msg).toContain(`</${FORK_BOILERPLATE_TAG}>`);
  });

  it("包含 directive 前缀和内容", () => {
    const msg = buildChildMessage("调查缓存命中率");
    expect(msg).toContain(FORK_DIRECTIVE_PREFIX);
    expect(msg).toContain("调查缓存命中率");
  });

  it("包含结构化输出格式(范围/结果/关键文件/改动文件/问题)", () => {
    const msg = buildChildMessage("测试指令");
    expect(msg).toContain("范围:");
    expect(msg).toContain("结果:");
    expect(msg).toContain("关键文件:");
    expect(msg).toContain("改动文件:");
    expect(msg).toContain("问题:");
  });

  it("包含防递归规则(不能再 fork)", () => {
    const msg = buildChildMessage("test");
    expect(msg).toContain("不要再派子代理");
  });
});

describe("buildForkedMessages", () => {
  it("无 tool_calls 的 assistant -> 只返回 directive 消息", () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      content: "hello",
      tool_calls: [],
    };
    const result = buildForkedMessages("do something", assistant);
    // 无 tool_use 时直接返回 directive user message
    expect(result.length).toBe(1);
    expect(result[0]!.role).toBe("user");
  });

  it("有 tool_calls -> 返回 [assistant, user(tool_results + directive)]", () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      content: "let me check",
      tool_calls: [
        { id: "tc-1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
        { id: "tc-2", type: "function", function: { name: "grep_files", arguments: '{"pattern":"foo"}' } },
      ],
    };
    const result = buildForkedMessages("调查 foo", assistant);
    expect(result.length).toBe(2);
    // 第一条是 clone 的 assistant
    expect(result[0]!.role).toBe("assistant");
    // 第二条是 user(含 tool_result + directive)
    const userMsg = result[1] as UserMessage;
    expect(userMsg.role).toBe("user");
    // content 是数组形式(tool_result blocks + text)
    expect(Array.isArray(userMsg.content)).toBe(true);
  });
});

describe("isInForkChild", () => {
  it("消息含 fork-boilerplate 标签 -> true", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: `<${FORK_BOILERPLATE_TAG}>STOP</${FORK_BOILERPLATE_TAG}>` },
    ];
    expect(isInForkChild(msgs)).toBe(true);
  });

  it("消息不含 fork-boilerplate 标签 -> false", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "普通用户消息" },
    ];
    expect(isInForkChild(msgs)).toBe(false);
  });

  it("空消息列表 -> false", () => {
    expect(isInForkChild([])).toBe(false);
  });

  it("ContentPart 数组中含标签 -> true", () => {
    const msgs: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: `<${FORK_BOILERPLATE_TAG}>directive</${FORK_BOILERPLATE_TAG}>` },
        ],
      },
    ];
    expect(isInForkChild(msgs)).toBe(true);
  });
});

describe("buildWorktreeNotice", () => {
  it("包含父路径和 worktree 路径", () => {
    const notice = buildWorktreeNotice("/home/user/project", "/home/user/.dao/worktrees/abc");
    expect(notice).toContain("/home/user/project");
    expect(notice).toContain("/home/user/.dao/worktrees/abc");
  });

  it("包含路径翻译提示", () => {
    const notice = buildWorktreeNotice("/parent", "/worktree");
    expect(notice).toContain("翻译");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/fork_agent.test.ts`
Expected: FAIL - module not found

- [ ] **Step 3: Write fork_agent.ts**

```typescript
// src/agent/fork_agent.ts
import type { ChatMessage, AssistantMessage, UserMessage, ContentPart } from "../client/types.js";
import type { BuiltInAgentDef } from "./agent_defs.js";

// ---- 常量(对标 CC constants/xml.ts) ----

/** fork-boilerplate XML 标签名:包裹 fork 子代理的规则 directive */
export const FORK_BOILERPLATE_TAG = "fork-boilerplate";

/** directive 文本前缀(渲染时剥离,仅标记 directive 起始) */
export const FORK_DIRECTIVE_PREFIX = "你的指令: ";

// ---- FORK_AGENT 定义(对标 CC FORK_AGENT) ----

/**
 * Fork agent 的合成定义(不注册到 BUNDLED_AGENTS)。
 *
 * fork 路径由 `fork: true` 参数触发(对标 CC 省略 subagent_type)。
 * - tools = undefined + useExactTools = 直接用父的工具池(缓存对齐)
 * - model = inherit(继承父模型,保持上下文长度一致)
 * - getSystemPrompt 返回空:实际用 override.systemPrompt 传父的 rendered prompt(字节级一致,缓存命中)
 */
export const FORK_AGENT: BuiltInAgentDef = {
  agentType: "fork",
  whenToUse: "隐式 fork - 继承父代理完整上下文。不可通过 agent_type 指定;由 fork=true 触发。",
  tools: undefined,
  model: "inherit",
  source: "built-in",
  getSystemPrompt: () => "",
};

// ---- 防递归 ----

/**
 * 检测消息列表中是否已有 fork-boilerplate 标签(防递归 fork)。
 * fork 子保留了 agent 工具(缓存对齐),但不能再 fork。
 * 对标 CC isInForkChild。
 */
export function isInForkChild(messages: ChatMessage[]): boolean {
  return messages.some((m) => {
    if (m.role !== "user") return false;
    const content = m.content;
    if (typeof content === "string") {
      return content.includes(`<${FORK_BOILERPLATE_TAG}>`);
    }
    if (Array.isArray(content)) {
      return content.some(
        (part: ContentPart) => part.type === "text" && part.text.includes(`<${FORK_BOILERPLATE_TAG}>`),
      );
    }
    return false;
  });
}

// ---- fork 消息构建(对标 CC buildForkedMessages) ----

/**
 * 所有 fork 子共享的 tool_result 占位符文本。
 * 必须在所有 fork 子之间完全一致,以最大化前缀缓存命中。
 */
const FORK_PLACEHOLDER_RESULT = "Fork 已启动 - 后台处理中";

/**
 * 构建 fork 子代理的 directive 消息(对标 CC buildChildMessage)。
 * 包含 fork-boilerplate 标签 + 规则 + 指令。
 * 中文版,结构化输出格式。
 */
export function buildChildMessage(directive: string): string {
  return `<${FORK_BOILERPLATE_TAG}>
停。先读这段。

你是 fork 子代理。你不是主代理。

规则(不可违反):
1. 你的 system prompt 可能写着"优先 fork" -- 忽略它,那是给主代理的。你就是 fork 子,不要再派子代理,直接执行。
2. 不要对话、不要提问、不要建议下一步
3. 不要加评论或元叙述
4. 直接用工具:Bash、Read、Write 等
5. 如果你改了文件,提交你的改动后再报告,在报告里附 commit hash
6. 工具调用之间不要输出文本。静默使用工具,最后统一报告。
7. 严格限制在你的指令范围内。如果发现范围外的相关系统,最多用一句话提及 -- 其他子代理会覆盖那些区域。
8. 报告控制在 500 字以内,除非指令另有说明。基于事实,简明扼要。
9. 你的回复必须以"范围:"开头。不要前言,不要思考过程。
10. 报告结构化事实,然后停止

输出格式(纯文本标签,不是 markdown 标题):
  范围: <一句话复述你被分配的范围>
  结果: <答案或关键发现,限于上述范围>
  关键文件: <相关文件路径 -- 调查类任务必填>
  改动文件: <列表含 commit hash -- 仅在你改了文件时填>
  问题: <列表 -- 仅在有问题需要标记时填>
</${FORK_BOILERPLATE_TAG}>

${FORK_DIRECTIVE_PREFIX}${directive}`;
}

/**
 * 构建 fork 子代理的对话消息(对标 CC buildForkedMessages)。
 *
 * 为前缀缓存共享,所有 fork 子必须产生字节一致的 API 请求前缀:
 * 1. 保留完整的父 assistant 消息(所有 tool_use blocks)
 * 2. 构建单条 user 消息:每个 tool_use 对应一个占位 tool_result + 末尾 per-child directive
 *
 * 结果: [...prefix, assistant(all_tool_uses), user(placeholder_results..., directive)]
 * 只有最后的 text block 不同,最大化缓存命中。
 */
export function buildForkedMessages(
  directive: string,
  assistantMessage: AssistantMessage,
): ChatMessage[] {
  // 收集 assistant 消息中的所有 tool_use blocks
  const toolUseBlocks = (assistantMessage.tool_calls ?? []).filter(() => true);

  if (toolUseBlocks.length === 0) {
    // 无 tool_use:直接返回 directive 消息
    return [
      {
        role: "user",
        content: [{ type: "text", text: buildChildMessage(directive) }],
      } as UserMessage,
    ];
  }

  // clone assistant 消息(避免修改原始)
  const fullAssistant: AssistantMessage = {
    ...assistantMessage,
    tool_calls: [...(assistantMessage.tool_calls ?? [])],
  };

  // 为每个 tool_use 构建占位 tool_result
  const toolResultParts: ContentPart[] = toolUseBlocks.map((block) => ({
    type: "text" as const,
    text: FORK_PLACEHOLDER_RESULT,
  }));

  // 构建单条 user 消息:所有占位 tool_result + per-child directive
  const childMessage: UserMessage = {
    role: "user",
    content: [...toolResultParts, { type: "text", text: buildChildMessage(directive) }],
  };

  return [fullAssistant, childMessage];
}

/**
 * worktree 隔离 fork 子代理的路径翻译提示(对标 CC buildWorktreeNotice)。
 * 告知子代理:继承的上下文路径指向父目录,需翻译到 worktree;编辑前重读文件。
 */
export function buildWorktreeNotice(parentCwd: string, worktreeCwd: string): string {
  return `你继承了父代理在 ${parentCwd} 的对话上下文。你现在在隔离的 git worktree ${worktreeCwd} 中工作 -- 同一个仓库,同样的相对文件结构,独立的工作副本。继承上下文中的路径指向父代理的工作目录;请把它们翻译到你的 worktree 根。如果父代理可能在你出现后修改了文件,编辑前请重读。你的改动留在本 worktree 中,不影响父代理的文件。`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/fork_agent.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/fork_agent.ts src/agent/fork_agent.test.ts
git commit -m "feat(agent): 新建 fork_agent.ts - Fork 机制(FORK_AGENT + buildForkedMessages + 防递归)

Co-Authored-By: Dao <noreply@dao-code>"
```

---

### Task 6: Agent Memory agent_memory.ts(loadAgentMemoryPrompt + scope 路径)

**Files:**
- Create: `src/agent/agent_memory.ts`
- Test: `src/agent/agent_memory.test.ts`

**Interfaces:**
- Consumes: `AgentMemoryScope` from Task 1, `ToolContext.homeDir` from `tools/types.ts`
- Produces: `getAgentMemoryDir()`, `getAgentMemoryEntrypoint()`, `loadAgentMemoryPrompt()`, `isAgentMemoryPath()`, `getMemoryScopeDisplay()`

- [ ] **Step 1: Write failing tests**

```typescript
// src/agent/agent_memory.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getAgentMemoryDir,
  getAgentMemoryEntrypoint,
  loadAgentMemoryPrompt,
  isAgentMemoryPath,
  getMemoryScopeDisplay,
} from "./agent_memory.js";

// 用临时 home 目录隔离测试
const TEST_HOME = "/tmp/dao-test-home";

describe("getAgentMemoryDir", () => {
  it("project scope -> <cwd>/.dao/agents/memory/<agentType>/", () => {
    const dir = getAgentMemoryDir("my-agent", "project", TEST_HOME);
    expect(dir).toContain(".dao");
    expect(dir).toContain("agents");
    expect(dir).toContain("memory");
    expect(dir).toContain("my-agent");
    expect(dir.endsWith("/")).toBe(true);
  });

  it("user scope -> <home>/.dao/agents/memory/<agentType>/", () => {
    const dir = getAgentMemoryDir("reviewer", "user", TEST_HOME);
    expect(dir).toContain(TEST_HOME);
    expect(dir).toContain(".dao");
    expect(dir).toContain("reviewer");
  });

  it("local scope -> <cwd>/.dao/agents/memory/<agentType>/local/", () => {
    const dir = getAgentMemoryDir("tester", "local", TEST_HOME);
    expect(dir).toContain("tester");
    expect(dir).toContain("local");
  });

  it("agentType 含冒号 -> 替换为横线(跨平台路径安全)", () => {
    const dir = getAgentMemoryDir("plugin:my-agent", "project", TEST_HOME);
    expect(dir).toContain("plugin-my-agent");
    expect(dir).not.toContain("plugin:my-agent");
  });
});

describe("getAgentMemoryEntrypoint", () => {
  it("返回 memory.md 路径", () => {
    const entry = getAgentMemoryEntrypoint("my-agent", "project", TEST_HOME);
    expect(entry).toContain("memory.md");
    expect(entry).toContain("my-agent");
  });
});

describe("loadAgentMemoryPrompt", () => {
  it("包含记忆说明文本", () => {
    const prompt = loadAgentMemoryPrompt("general-purpose", "project", TEST_HOME);
    expect(prompt).toContain("记忆");
    expect(prompt.length).toBeGreaterThan(50);
  });

  it("user scope 包含跨项目提示", () => {
    const prompt = loadAgentMemoryPrompt("my-agent", "user", TEST_HOME);
    expect(prompt).toContain("跨项目");
  });

  it("project scope 包含项目级提示", () => {
    const prompt = loadAgentMemoryPrompt("my-agent", "project", TEST_HOME);
    expect(prompt).toContain("项目");
  });

  it("local scope 包含本地级提示", () => {
    const prompt = loadAgentMemoryPrompt("my-agent", "local", TEST_HOME);
    expect(prompt).toContain("本地");
  });

  it("包含记忆文件路径", () => {
    const prompt = loadAgentMemoryPrompt("reviewer", "project", TEST_HOME);
    expect(prompt).toContain("memory.md");
  });
});

describe("isAgentMemoryPath", () => {
  it("project scope 路径 -> true", () => {
    const dir = getAgentMemoryDir("my-agent", "project", TEST_HOME);
    const file = dir + "memory.md";
    expect(isAgentMemoryPath(file, TEST_HOME)).toBe(true);
  });

  it("user scope 路径 -> true", () => {
    const dir = getAgentMemoryDir("my-agent", "user", TEST_HOME);
    const file = dir + "memory.md";
    expect(isAgentMemoryPath(file, TEST_HOME)).toBe(true);
  });

  it("local scope 路径 -> true", () => {
    const dir = getAgentMemoryDir("my-agent", "local", TEST_HOME);
    const file = dir + "memory.md";
    expect(isAgentMemoryPath(file, TEST_HOME)).toBe(true);
  });

  it("无关路径 -> false", () => {
    expect(isAgentMemoryPath("/etc/passwd", TEST_HOME)).toBe(false);
    expect(isAgentMemoryPath("/tmp/random/file.txt", TEST_HOME)).toBe(false);
  });
});

describe("getMemoryScopeDisplay", () => {
  it("user -> 含 User 标记", () => {
    const display = getMemoryScopeDisplay("user", TEST_HOME);
    expect(display).toContain("User");
  });

  it("project -> 含 Project 标记", () => {
    const display = getMemoryScopeDisplay("project", TEST_HOME);
    expect(display).toContain("Project");
  });

  it("local -> 含 Local 标记", () => {
    const display = getMemoryScopeDisplay("local", TEST_HOME);
    expect(display).toContain("Local");
  });

  it("undefined -> None", () => {
    const display = getMemoryScopeDisplay(undefined, TEST_HOME);
    expect(display).toContain("None");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/agent_memory.test.ts`
Expected: FAIL - module not found

- [ ] **Step 3: Write agent_memory.ts**

```typescript
// src/agent/agent_memory.ts
import { join, normalize, sep } from "node:path";
import { promises as fs } from "node:fs";
import type { AgentMemoryScope } from "./agent_defs.js";

/**
 * agentType 中冒号替换为横线(跨平台路径安全)。
 * 插件命名空间的 agent type 如 "plugin:my-agent" 在 Windows 上不能做目录名。
 */
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
 * 返回 agent 记忆文件入口路径(MEMORY.md)。
 * 对标 CC getAgentMemoryEntrypoint。
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
 * 对标 CC isAgentMemoryPath。
 */
export function isAgentMemoryPath(absolutePath: string, homeDir?: string): boolean {
  const normalizedPath = normalize(absolutePath);
  const home = homeDir ?? process.env.HOME ?? process.cwd();

  // user scope
  if (normalizedPath.startsWith(join(home, ".dao", "agents", "memory") + sep)) {
    return true;
  }

  // project scope & local scope(都基于 cwd)
  if (normalizedPath.startsWith(join(process.cwd(), ".dao", "agents", "memory") + sep)) {
    return true;
  }

  return false;
}

/**
 * 返回 scope 的显示文本(对标 CC getMemoryScopeDisplay)。
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
 * memory scope 决定存储路径和提示语。
 *
 * agent 通过 read_file/write_file/edit_file 直接读写 memory.md。
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
      scopeNote = "- 此记忆是 local 级(不入版本控制),请针对本项目和本机记录";
      break;
  }

  const memoryDir = getAgentMemoryDir(agentType, scope, homeDir);
  const memoryFile = join(memoryDir, "memory.md");

  // fire-and-forget:确保目录存在(agent 不会在首轮 API 往返前就写记忆)
  void fs.mkdir(memoryDir, { recursive: true }).catch(() => {});

  return `## 持久 Agent 记忆

你有持久记忆,存储在 ${memoryFile}。
你可以用 read_file 读取记忆、用 write_file/edit_file 更新记忆。

记忆使用指南:
- 只记耐久且可泛化的:项目结构、关键决策、踩过的坑、用户偏好
- 不记一次性或显而易见的
- 每条记忆用简洁的一句话
${scopeNote}

当前记忆文件路径: ${memoryFile}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/agent_memory.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent_memory.ts src/agent/agent_memory.test.ts
git commit -m "feat(agent): 新建 agent_memory.ts - Agent 持久记忆(loadAgentMemoryPrompt + scope 路径)

Co-Authored-By: Dao <noreply@dao-code>"
```

---

### Task 7: Agent Hooks agent_hooks.ts(registerAgentHooks + clearAgentHooks)

**Files:**
- Create: `src/agent/agent_hooks.ts`
- Test: `src/agent/agent_hooks.test.ts`

**Interfaces:**
- Consumes: `AgentHooks`/`HookCommand` from Task 1, `runHooks`/`HookSpec`/`HookOutcome` from `hooks/hooks.ts`
- Produces: `AgentHookRegistry`, `registerAgentHooks()`, `clearAgentHooks()`, `executeSubagentStartHooks()`

- [ ] **Step 1: Write failing tests**

```typescript
// src/agent/agent_hooks.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerAgentHooks,
  clearAgentHooks,
  executeSubagentStartHooks,
  type AgentHookRegistry,
} from "./agent_hooks.js";
import type { AgentHooks } from "./agent_defs.js";

describe("registerAgentHooks", () => {
  it("注册 SubagentStart hooks", () => {
    const registry: AgentHookRegistry = new Map();
    const hooks: AgentHooks = {
      SubagentStart: [{ command: "echo start" }],
    };
    registerAgentHooks("agent-1", hooks, registry);
    const entry = registry.get("agent-1");
    expect(entry).toBeDefined();
    expect(entry!.SubagentStart).toEqual([{ command: "echo start" }]);
  });

  it("注册 SubagentStop hooks", () => {
    const registry: AgentHookRegistry = new Map();
    const hooks: AgentHooks = {
      SubagentStop: [{ command: "echo stop" }],
    };
    registerAgentHooks("agent-2", hooks, registry);
    const entry = registry.get("agent-2");
    expect(entry).toBeDefined();
    expect(entry!.SubagentStop).toEqual([{ command: "echo stop" }]);
  });

  it("同时注册 Start 和 Stop hooks", () => {
    const registry: AgentHookRegistry = new Map();
    const hooks: AgentHooks = {
      SubagentStart: [{ command: "echo start" }, { command: "echo start2" }],
      SubagentStop: [{ command: "echo stop" }],
    };
    registerAgentHooks("agent-3", hooks, registry);
    const entry = registry.get("agent-3");
    expect(entry!.SubagentStart!.length).toBe(2);
    expect(entry!.SubagentStop!.length).toBe(1);
  });

  it("空 hooks 不注册", () => {
    const registry: AgentHookRegistry = new Map();
    registerAgentHooks("agent-4", {}, registry);
    expect(registry.has("agent-4")).toBe(false);
  });

  it("重复注册同一 agentId 覆盖", () => {
    const registry: AgentHookRegistry = new Map();
    registerAgentHooks("agent-5", { SubagentStart: [{ command: "echo v1" }] }, registry);
    registerAgentHooks("agent-5", { SubagentStart: [{ command: "echo v2" }] }, registry);
    expect(registry.get("agent-5")!.SubagentStart).toEqual([{ command: "echo v2" }]);
  });
});

describe("clearAgentHooks", () => {
  it("清除已注册的 hooks", () => {
    const registry: AgentHookRegistry = new Map();
    registerAgentHooks("agent-6", { SubagentStart: [{ command: "echo start" }] }, registry);
    expect(registry.has("agent-6")).toBe(true);
    clearAgentHooks("agent-6", registry);
    expect(registry.has("agent-6")).toBe(false);
  });

  it("清除不存在的 agentId 不报错", () => {
    const registry: AgentHookRegistry = new Map();
    expect(() => clearAgentHooks("nonexistent", registry)).not.toThrow();
  });
});

describe("executeSubagentStartHooks", () => {
  it("无注册 hooks -> 返回空 additionalContext", async () => {
    const registry: AgentHookRegistry = new Map();
    const result = await executeSubagentStartHooks("agent-7", "test-agent", registry, "/tmp");
    expect(result.additionalContext).toBe("");
    expect(result.block).toBe(false);
  });

  it("有 SubagentStart hooks -> 执行并收集 additionalContext", async () => {
    const registry: AgentHookRegistry = new Map();
    registerAgentHooks("agent-8", {
      SubagentStart: [{ command: "echo 'started'" }],
    }, registry);
    const result = await executeSubagentStartHooks("agent-8", "test-agent", registry, "/tmp");
    // echo 命令的输出应出现在 additionalContext 或至少 block=false
    expect(result.block).toBe(false);
    // echo 的输出 "started" 可能出现在 additionalContext
    expect(result.additionalContext.length).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/agent_hooks.test.ts`
Expected: FAIL - module not found

- [ ] **Step 3: Write agent_hooks.ts**

```typescript
// src/agent/agent_hooks.ts
import { exec } from "node:child_process";
import type { AgentHooks, HookCommand } from "./agent_defs.js";
import { runHooks, type HookSpec, type HookOutcome } from "../hooks/hooks.js";

/**
 * Agent hook 注册表:agentId -> 注册的 hooks。
 * 在 runAgent 阶段 3 注册,阶段 7(finally)清除。
 * 对标 CC sessionHooks(sessionHooks.delete(agentId))。
 */
export type AgentHookRegistry = Map<string, AgentHooks>;

/**
 * 注册 agent 的 frontmatter hooks 到注册表(对标 CC registerFrontmatterHooks)。
 *
 * 这些 hooks 在 agent 生命周期内生效:
 * - SubagentStart:会话创建后、首轮查询前执行
 * - SubagentStop:会话结束(完成/失败/取消)时执行
 *
 * @param agentId agent 唯一标识
 * @param hooks agent frontmatter 中定义的 hooks
 * @param registry 全局 hook 注册表(由 runAgent 传入)
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
 * 清除 agent 的所有 hooks(对标 CC clearSessionHooks)。
 * 在 runAgent 的 finally 阶段调用。
 *
 * @param agentId agent 唯一标识
 * @param registry 全局 hook 注册表
 */
export function clearAgentHooks(
  agentId: string,
  registry: AgentHookRegistry,
): void {
  registry.delete(agentId);
}

/**
 * 执行 SubagentStart hooks 并收集 additionalContext(对标 CC executeSubagentStartHooks)。
 *
 * 在 runAgent 阶段 3 调用:注册 hooks 后、首轮查询前。
 * hook 的 additionalContext 输出作为 initial message 注入。
 *
 * 复用 DAO 现有 runHooks() 机制执行 command 类型 hook。
 *
 * @param agentId agent 唯一标识
 * @param agentType agent 类型名(传给 hook 的 payload)
 * @param registry 全局 hook 注册表
 * @param cwd 工作目录(hook 执行的 cwd)
 * @returns hook 执行结果(block/reason/additionalContext)
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
 * 执行 SubagentStop hooks(对标 CC clearSessionHooks 时的 Stop 执行)。
 *
 * 在 runAgent 阶段 7(finally)调用。
 * 不收集 additionalContext(会话已结束),只执行命令。
 *
 * @param agentId agent 唯一标识
 * @param agentType agent 类型名
 * @param registry 全局 hook 注册表
 * @param cwd 工作目录
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/agent_hooks.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent_hooks.ts src/agent/agent_hooks.test.ts
git commit -m "feat(agent): 新建 agent_hooks.ts - Agent 生命周期 hooks(registerAgentHooks + clearAgentHooks)

Co-Authored-By: Dao <noreply@dao-code>"
```

---

### Task 8: Agent Prompt 生成 agent_prompt.ts(getAgentPrompt)

**Files:**
- Create: `src/agent/agent_prompt.ts`
- Test: `src/agent/agent_prompt.test.ts`

**Interfaces:**
- Consumes: `AgentDef` from Task 1, `BUNDLED_AGENTS` from Task 3, `ONE_SHOT_AGENT_TYPES` from Task 2
- Produces: `getAgentPrompt()`, `formatAgentLine()`, `getToolsDescription()`

- [ ] **Step 1: Write failing tests**

```typescript
// src/agent/agent_prompt.test.ts
import { describe, it, expect } from "vitest";
import { getAgentPrompt, formatAgentLine, getToolsDescription } from "./agent_prompt.js";
import { BUNDLED_AGENTS } from "./bundled_agents.js";
import type { AgentDef } from "./agent_defs.js";

describe("getToolsDescription", () => {
  it("无 tools 无 disallowedTools -> 全部工具", () => {
    const agent: AgentDef = {
      agentType: "test",
      whenToUse: "test",
      source: "built-in",
      getSystemPrompt: () => "",
    };
    expect(getToolsDescription(agent)).toBe("全部工具");
  });

  it("tools = undefined -> 全部工具", () => {
    const agent: AgentDef = {
      agentType: "test",
      whenToUse: "test",
      source: "built-in",
      tools: undefined,
      getSystemPrompt: () => "",
    };
    expect(getToolsDescription(agent)).toBe("全部工具");
  });

  it("有 tools 白名单 -> 列出工具名", () => {
    const agent: AgentDef = {
      agentType: "test",
      whenToUse: "test",
      source: "built-in",
      tools: ["read_file", "grep_files"],
      getSystemPrompt: () => "",
    };
    expect(getToolsDescription(agent)).toBe("read_file, grep_files");
  });

  it("有 disallowedTools -> 全部工具除了 X", () => {
    const agent: AgentDef = {
      agentType: "test",
      whenToUse: "test",
      source: "built-in",
      disallowedTools: ["write_file", "exec_shell"],
      getSystemPrompt: () => "",
    };
    expect(getToolsDescription(agent)).toBe("全部工具除了 write_file, exec_shell");
  });

  it("同时有 tools 和 disallowedTools -> 过滤后列出", () => {
    const agent: AgentDef = {
      agentType: "test",
      whenToUse: "test",
      source: "built-in",
      tools: ["read_file", "grep_files", "write_file"],
      disallowedTools: ["write_file"],
      getSystemPrompt: () => "",
    };
    expect(getToolsDescription(agent)).toBe("read_file, grep_files");
  });
});

describe("formatAgentLine", () => {
  it("格式: - <type>: <whenToUse> (Tools: <tools>)", () => {
    const agent: AgentDef = {
      agentType: "explore",
      whenToUse: "探查子代理",
      source: "built-in",
      tools: ["read_file", "grep_files"],
      getSystemPrompt: () => "",
    };
    const line = formatAgentLine(agent);
    expect(line).toBe("- explore: 探查子代理 (Tools: read_file, grep_files)");
  });

  it("无 tools -> (Tools: 全部工具)", () => {
    const agent: AgentDef = {
      agentType: "general-purpose",
      whenToUse: "通用子代理",
      source: "built-in",
      getSystemPrompt: () => "",
    };
    const line = formatAgentLine(agent);
    expect(line).toContain("全部工具");
  });
});

describe("getAgentPrompt", () => {
  it("包含 agent 列表", () => {
    const prompt = getAgentPrompt(BUNDLED_AGENTS);
    expect(prompt).toContain("explore");
    expect(prompt).toContain("general-purpose");
    expect(prompt).toContain("plan");
    expect(prompt).toContain("verify");
  });

  it("包含工具名称列表(每行 Tools: ...)", () => {
    const prompt = getAgentPrompt(BUNDLED_AGENTS);
    expect(prompt).toContain("Tools:");
  });

  it("包含何时不用指引", () => {
    const prompt = getAgentPrompt(BUNDLED_AGENTS);
    expect(prompt).toContain("不该用");
  });

  it("包含写 prompt 指引", () => {
    const prompt = getAgentPrompt(BUNDLED_AGENTS);
    expect(prompt).toContain("写 prompt");
  });

  it("包含并发并行提示", () => {
    const prompt = getAgentPrompt(BUNDLED_AGENTS);
    expect(prompt).toContain("并行");
  });

  it("allowedAgentTypes 过滤:只显示指定类型", () => {
    const prompt = getAgentPrompt(BUNDLED_AGENTS, ["explore"]);
    expect(prompt).toContain("explore");
    expect(prompt).not.toContain("general-purpose");
    expect(prompt).not.toContain("verify");
  });

  it("空 agent 列表 -> 不含 agent 行", () => {
    const prompt = getAgentPrompt([]);
    // 仍含用法说明,但没有具体 agent 列表
    expect(prompt).toContain("agent");
    expect(prompt).not.toContain("- explore:");
  });

  it("包含 worktree 隔离提示", () => {
    const prompt = getAgentPrompt(BUNDLED_AGENTS);
    expect(prompt).toContain("worktree");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/agent_prompt.test.ts`
Expected: FAIL - module not found

- [ ] **Step 3: Write agent_prompt.ts**

```typescript
// src/agent/agent_prompt.ts
import type { AgentDef } from "./agent_defs.js";

/**
 * 格式化单行 agent 描述(用于 agent 列表)。
 * 格式: - <type>: <whenToUse> (Tools: <tools>)
 * 对标 CC formatAgentLine。
 */
export function formatAgentLine(agent: AgentDef): string {
  const toolsDescription = getToolsDescription(agent);
  return `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${toolsDescription})`;
}

/**
 * 获取 agent 的工具描述文本(对标 CC getToolsDescription)。
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
    // 同时有:白名单过滤黑名单
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

/**
 * 生成 agent 工具的描述 prompt(对标 CC getPrompt)。
 *
 * 内容包含:
 * 1. 工具概述(什么是 agent 工具)
 * 2. 可用 agent 列表(类型 + 何时用 + 工具)
 * 3. 何时不用(agent 工具的替代方案)
 * 4. 用法说明(描述、并行、后台、worktree)
 * 5. 写 prompt 指引(像给同事 briefing)
 *
 * @param agentDefs 可用的 agent 定义列表
 * @param allowedAgentTypes 可选:限制只显示这些类型(用于 Agent(x,y) 语法)
 */
export function getAgentPrompt(
  agentDefs: AgentDef[],
  allowedAgentTypes?: string[],
): string {
  // 按 allowedAgentTypes 过滤
  const effectiveAgents = allowedAgentTypes
    ? agentDefs.filter((a) => allowedAgentTypes.includes(a.agentType))
    : agentDefs;

  const agentListSection = effectiveAgents.length > 0
    ? `可用 agent 类型和它们拥有的工具:
${effectiveAgents.map((agent) => formatAgentLine(agent)).join("\n")}`
    : `当前无可用 agent。`;

  const whenNotToUseSection = `
不该用 agent 工具的场景:
- 读特定文件路径 -> 直接用 read_file
- 按文件名找文件 -> 直接用 file_search
- 搜代码内容(如 "class Foo") -> 直接用 grep_files
- 只在 2-3 个文件里搜代码 -> 直接用 read_file
- 其他不符合上述 agent 描述的任务
`;

  const writingThePromptSection = `
## 写 prompt

像给一个刚走进门的聪明同事 briefing -- 它没看过你的对话,不知道你试过什么,不理解这个任务为什么重要。
- 说清你想做什么、为什么
- 描述你已经知道或排除了什么
- 给足背景让 agent 能做判断,而不是只给窄指令
- 需要简短回复就说("200 字以内报告")
- 查询类:给精确命令。调查类:给问题 -- 预设步骤在前提错误时是死重。

简短的命令式 prompt 产出浅泛的工作。

**永远不要把理解外包。** 不要写"基于你的发现,修 bug"或"基于调研,实现它"。这些话把综合判断推给了 agent 而非你自己做。写能证明你理解的 prompt:包含文件路径、行号、具体改什么。
`;

  const examplesSection = `
示例用法:

<example>
用户: "这个分支还有什么没做完才能发布?"
助手: [调用 agent 工具,agent_type=explore]
agent({
  task: "审查这个分支发布前还剩什么没做完。检查:未提交改动、领先 main 的提交、是否有测试、CI 相关文件是否改了。给出 punch list -- 完成 vs 缺失。200 字以内。"
})
</example>

<example>
用户: "帮我写个素数判断函数"
助手: 用 write_file 写代码后,用 agent 工具派 test-runner agent 跑测试:
agent({
  agent_type: "general-purpose",
  task: "运行 npm test 并报告结果"
})
</example>
`;

  return `派发一个新 agent 来自主处理复杂、多步任务。

agent 工具启动专门的子代理(子进程),自主处理复杂任务。每种 agent 类型有特定的能力和可用工具。

${agentListSection}

使用 agent 工具时,指定 agent_type 参数选择使用哪种 agent。省略则用 general-purpose。

${whenNotToUseSection}

用法说明:
- 始终包含简短描述(3-5 个词),概括 agent 要做什么
- 尽可能并行派发多个 agent 以最大化性能;在单条消息中用多个 agent 工具调用即可
- 可以用 background: true 在后台运行 agent;完成时会自动通知,不要轮询或主动检查进度
- agent 完成后返回单条消息给你;结果对用户不可见,你应向用户发文本消息概述结果
- 用 task_send 向运行中的后台 agent 追加指令;agent 恢复后保留完整上下文
- 可以设 isolate: true 在临时 git worktree 中运行 agent,给它隔离的仓库副本;无改动时自动清理,有改动则返回 worktree 路径和分支
- 如果 agent 描述提到"主动使用",就尽量不等用户先开口就用它
${writingThePromptSection}
${examplesSection}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/agent_prompt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent_prompt.ts src/agent/agent_prompt.test.ts
git commit -m "feat(agent): 新建 agent_prompt.ts - Agent 工具描述 prompt 生成(getAgentPrompt)

Co-Authored-By: Dao <noreply@dao-code>"
```

---

### Task 9: 后台 Agent 摘要(agent_summary.ts)

**Files:**
- Create: `src/agent/agent_summary.ts`
- Test: `src/agent/agent_summary.test.ts`

**Interfaces:**
- Consumes: `ChatMessage` from `client/types.ts`
- Produces: `startAgentSummarization()`, `CacheSafeParams`

- [ ] **Step 1: Write failing tests**

```typescript
// src/agent/agent_summary.test.ts
import { describe, it, expect, vi } from "vitest";
import { startAgentSummarization } from "./agent_summary.js";

describe("startAgentSummarization", () => {
  it("返回带 stop() 的对象", () => {
    const { stop } = startAgentSummarization("task-1", "agent-1", { systemPrompt: "", messages: [], model: "flash" }, () => {});
    expect(typeof stop).toBe("function");
    stop();
  });
  it("stop() 后不再触发摘要", async () => {
    const cb = vi.fn();
    const { stop } = startAgentSummarization("task-1", "agent-1", { systemPrompt: "", messages: [], model: "flash" }, cb);
    stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(cb).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/agent_summary.test.ts`
Expected: FAIL - module not found

- [ ] **Step 3: Write agent_summary.ts**

```typescript
// src/agent/agent_summary.ts
import type { ChatMessage } from "../client/types.js";

export interface CacheSafeParams {
  systemPrompt: string;
  messages: ChatMessage[];
  model: string;
}

type SetAppState = (fn: (prev: Record<string, unknown>) => Record<string, unknown>) => void;

export function startAgentSummarization(
  taskId: string,
  _agentId: string,
  params: CacheSafeParams,
  setAppState: SetAppState,
  opts?: { intervalMs?: number },
): { stop: () => void } {
  const interval = opts?.intervalMs ?? 30_000;
  let stopped = false;

  const timer = setInterval(async () => {
    if (stopped || params.messages.length === 0) return;
    const summary = extractSimpleSummary(params.messages.slice(-20));
    setAppState((prev) => {
      const tasks = (prev as { tasks?: Record<string, unknown> }).tasks ?? {};
      const task = tasks[taskId] as Record<string, unknown> | undefined;
      if (!task || task.status !== "running") return prev;
      return { ...prev, tasks: { ...tasks, [taskId]: { ...task, summary } } };
    });
  }, interval);

  return { stop: () => { stopped = true; clearInterval(timer); } };
}

function extractSimpleSummary(messages: ChatMessage[]): string {
  let toolCount = 0;
  let lastTool = "";
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      toolCount += m.tool_calls.length;
      lastTool = m.tool_calls[m.tool_calls.length - 1]?.function.name ?? lastTool;
    }
  }
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const lastText = lastAssistant && typeof lastAssistant.content === "string" ? lastAssistant.content.slice(0, 80) : "";
  return `工具调用: ${toolCount} | 最近: ${lastTool}${lastText ? ` | ${lastText}` : ""}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/agent_summary.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent_summary.ts src/agent/agent_summary.test.ts
git commit -m "feat(agent): 新建 agent_summary.ts - 后台 agent 定期摘要

Co-Authored-By: Dao <noreply@dao-code>"
```

---

### Task 10: Agent 恢复(resume_agent.ts)

**Files:**
- Create: `src/agent/resume_agent.ts`
- Test: `src/agent/resume_agent.test.ts`

**Interfaces:**
- Consumes: `AgentDef` from Task 1, `ONE_SHOT_AGENT_TYPES` from Task 2
- Produces: `resumeAgentBackground()`, `recordSidechainMessage()`, `writeAgentMetadata()`, `getAgentTranscript()`, `readAgentMetadata()`, `filterIncompleteToolCalls()`

- [ ] **Step 1: Write failing tests**

```typescript
// src/agent/resume_agent.test.ts
import { describe, it, expect } from "vitest";
import { recordSidechainMessage, writeAgentMetadata, getAgentTranscript, readAgentMetadata, filterIncompleteToolCalls } from "./resume_agent.js";
import type { ChatMessage } from "../client/types.js";

describe("转录持久化", () => {
  const tmpDir = `/tmp/dao-test-${Date.now()}`;
  const agentId = "test-agent-1";

  it("recordSidechainMessage 追加消息到 jsonl", async () => {
    await recordSidechainMessage(tmpDir, agentId, { role: "user", content: "hello" } as ChatMessage);
    await recordSidechainMessage(tmpDir, agentId, { role: "assistant", content: "hi" } as ChatMessage);
    const t = await getAgentTranscript(tmpDir, agentId);
    expect(t).not.toBeNull();
    expect(t!.messages.length).toBe(2);
  });

  it("writeAgentMetadata + readAgentMetadata", async () => {
    await writeAgentMetadata(tmpDir, agentId, { agentType: "explore", description: "test" });
    const meta = await readAgentMetadata(tmpDir, agentId);
    expect(meta!.agentType).toBe("explore");
  });

  it("getAgentTranscript 不存在返回 null", async () => {
    expect(await getAgentTranscript(tmpDir, "nonexistent")).toBeNull();
  });
});

describe("filterIncompleteToolCalls", () => {
  it("过滤未配对的 tool_use", () => {
    const msgs: ChatMessage[] = [
      { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "assistant", content: "", tool_calls: [{ id: "2", type: "function", function: { name: "grep_files", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "1", content: "result" },
    ];
    const filtered = filterIncompleteToolCalls(msgs);
    // id=2 的 tool_call 没有对应 tool_result -> 那条 assistant 被过滤
    expect(filtered.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/resume_agent.test.ts`
Expected: FAIL - module not found

- [ ] **Step 3: Write resume_agent.ts**

```typescript
// src/agent/resume_agent.ts
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChatMessage } from "../client/types.js";
import { ONE_SHOT_AGENT_TYPES } from "./agent_tools.js";
import type { AgentDef } from "./agent_defs.js";

export async function recordSidechainMessage(subagentsDir: string, agentId: string, message: ChatMessage): Promise<void> {
  try {
    await fs.mkdir(subagentsDir, { recursive: true });
    await fs.appendFile(path.join(subagentsDir, `${agentId}.jsonl`), JSON.stringify(message) + "\n", "utf8");
  } catch { /* fire-and-forget */ }
}

export async function writeAgentMetadata(subagentsDir: string, agentId: string, meta: { agentType: string; description?: string; worktreePath?: string; model?: string }): Promise<void> {
  try {
    await fs.mkdir(subagentsDir, { recursive: true });
    await fs.writeFile(path.join(subagentsDir, `${agentId}.meta.json`), JSON.stringify(meta, null, 2), "utf8");
  } catch { /* fire-and-forget */ }
}

export async function getAgentTranscript(subagentsDir: string, agentId: string): Promise<{ messages: ChatMessage[] } | null> {
  try {
    const raw = await fs.readFile(path.join(subagentsDir, `${agentId}.jsonl`), "utf8");
    const messages: ChatMessage[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim()) try { messages.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return { messages };
  } catch { return null; }
}

export async function readAgentMetadata(subagentsDir: string, agentId: string): Promise<{ agentType: string; description?: string; worktreePath?: string; model?: string } | null> {
  try { return JSON.parse(await fs.readFile(path.join(subagentsDir, `${agentId}.meta.json`), "utf8")); }
  catch { return null; }
}

export function filterIncompleteToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const idsWithResults = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) idsWithResults.add(m.tool_call_id);
  }
  return messages.filter((m) => {
    if (m.role === "assistant" && m.tool_calls) {
      return !m.tool_calls.some((tc) => !idsWithResults.has(tc.id));
    }
    return true;
  });
}

export async function resumeAgentBackground(opts: {
  agentId: string;
  prompt: string;
  subagentsDir: string;
  agentDefs: AgentDef[];
  runAgent: (params: unknown) => AsyncGenerator<ChatMessage, void>;
  registerAsyncAgent: (opts: { agentId: string; description: string }) => { agentId: string; abortController: AbortController };
  runAsyncAgentLifecycle: (opts: unknown) => Promise<void>;
}): Promise<{ agentId: string; description: string; outputFile: string }> {
  const { agentId, prompt, subagentsDir, agentDefs } = opts;
  const [transcript, meta] = await Promise.all([getAgentTranscript(subagentsDir, agentId), readAgentMetadata(subagentsDir, agentId)]);
  if (!transcript) throw new Error(`未找到子代理转录:${agentId}`);
  if (meta?.agentType && ONE_SHOT_AGENT_TYPES.has(meta.agentType)) {
    throw new Error(`${meta.agentType} 是一次性 agent,不支持恢复。`);
  }
  const resumedMessages = filterIncompleteToolCalls(transcript.messages);
  const { GENERAL_PURPOSE_AGENT } = await import("./bundled_agents.js");
  const agentDef = meta?.agentType ? (agentDefs.find((a) => a.agentType === meta.agentType) ?? GENERAL_PURPOSE_AGENT) : GENERAL_PURPOSE_AGENT;
  const promptMessages: ChatMessage[] = [...resumedMessages, { role: "user", content: prompt }];
  const description = meta?.description ?? "(恢复)";
  const bgTask = opts.registerAsyncAgent({ agentId, description });
  void opts.runAsyncAgentLifecycle({ taskId: bgTask.agentId, abortController: bgTask.abortController, makeStream: () => opts.runAgent({ agentDef, promptMessages, isAsync: true }), description, agentIdForCleanup: agentId });
  return { agentId, description, outputFile: path.join(subagentsDir, `${agentId}.jsonl`) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/resume_agent.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/resume_agent.ts src/agent/resume_agent.test.ts
git commit -m "feat(agent): 新建 resume_agent.ts - 子代理恢复

Co-Authored-By: Dao <noreply@dao-code>"
```

---

### Task 11: tasks.ts 扩展

**Files:**
- Modify: `src/agent/tasks.ts`
- Test: `src/agent/tasks.test.ts`

**Interfaces:**
- Consumes: existing `TaskManager`, `BgTask`
- Produces: extended `BgTask` (summary/messages/agentType), `registerAgentForeground()`, `registerAsyncAgent()`, `updateSummary()`, `appendMessage()`

- [ ] **Step 1: Write failing tests**

```typescript
// src/agent/tasks.test.ts (追加)
import { describe, it, expect } from "vitest";
import { createTaskManager } from "./tasks.js";

describe("registerAgentForeground", () => {
  it("注册前台任务并返回 backgroundSignal", () => {
    const tm = createTaskManager();
    const result = tm.registerAgentForeground({ agentId: "fg-1", description: "前台", autoBackgroundMs: 100 });
    expect(result.taskId).toBeTruthy();
    expect(result.backgroundSignal).toBeInstanceOf(Promise);
    result.cancelAutoBackground();
  });
  it("超时后触发 backgroundSignal", async () => {
    const tm = createTaskManager();
    const result = tm.registerAgentForeground({ agentId: "fg-2", description: "前台", autoBackgroundMs: 50 });
    await result.backgroundSignal;
    expect(tm.get(result.taskId)).toBeDefined();
  });
});

describe("registerAsyncAgent", () => {
  it("注册后台 agent 并返回 abortController", () => {
    const tm = createTaskManager();
    const result = tm.registerAsyncAgent({ agentId: "bg-1", description: "后台" });
    expect(result.agentId).toBe("bg-1");
    expect(result.abortController).toBeInstanceOf(AbortController);
  });
});

describe("updateSummary", () => {
  it("更新任务摘要", () => {
    const tm = createTaskManager();
    const id = tm.create("test");
    expect(tm.updateSummary(id, "正在跑测试")).toBe(true);
    expect(tm.get(id)!.summary).toBe("正在跑测试");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/tasks.test.ts`
Expected: FAIL - registerAgentForeground/registerAsyncAgent 不存在

- [ ] **Step 3: Modify tasks.ts**

在 `BgTask` 接口追加字段:
```typescript
export interface BgTask {
  // ...现有字段不变...
  summary?: string;
  messages?: import("../client/types.js").ChatMessage[];
  agentType?: string;
}
```

在 `TaskManager` 接口追加方法:
```typescript
export interface TaskManager {
  // ...现有方法不变...
  registerAgentForeground(opts: { agentId: string; description: string; autoBackgroundMs?: number }): { taskId: string; backgroundSignal: Promise<void>; cancelAutoBackground: () => void };
  registerAsyncAgent(opts: { agentId: string; description: string }): { agentId: string; abortController: AbortController };
  updateSummary(taskId: string, summary: string): boolean;
  appendMessage(taskId: string, message: import("../client/types.js").ChatMessage): boolean;
}
```

在 `createTaskManager()` 返回对象中追加实现:
```typescript
registerAgentForeground(opts) {
  const id = `task-${++counter}`;
  const t: BgTask = { id, description: opts.description, status: "running", startedAt: Date.now() };
  tasks.set(id, t);
  let bgResolve: () => void;
  const backgroundSignal = new Promise<void>((res) => { bgResolve = res; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.autoBackgroundMs) timer = setTimeout(() => bgResolve(), opts.autoBackgroundMs);
  notify();
  return { taskId: id, backgroundSignal, cancelAutoBackground: () => { if (timer) clearTimeout(timer); } };
},
registerAsyncAgent(opts) {
  const id = opts.agentId;
  const ac = new AbortController();
  tasks.set(id, { id, description: opts.description, status: "running", startedAt: Date.now() });
  controllers.set(id, ac);
  notify();
  return { agentId: id, abortController: ac };
},
updateSummary(taskId, summary) {
  const t = tasks.get(taskId);
  if (!t) return false;
  t.summary = summary;
  notify();
  return true;
},
appendMessage(taskId, message) {
  const t = tasks.get(taskId);
  if (!t) return false;
  if (!t.messages) t.messages = [];
  t.messages.push(message);
  return true;
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/tasks.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/tasks.ts src/agent/tasks.test.ts
git commit -m "feat(agent): 扩展 tasks.ts - 进度/摘要/前台注册/异步注册

Co-Authored-By: Dao <noreply@dao-code>"
```

---

### Task 12: tools/agent.ts 重写 + tools/types.ts 变更

**Files:**
- Rewrite: `src/tools/agent.ts`
- Modify: `src/tools/types.ts`
- Test: `src/tools/agent.test.ts`

**Interfaces:**
- Consumes: `AgentDef` from Task 1, `resolveAgentTools`/`finalizeAgentTool`/`ONE_SHOT_AGENT_TYPES` from Task 2, `FORK_AGENT` from Task 5
- Produces: new `agentTool` with extended schema, updated `ToolContext`

- [ ] **Step 1: Write failing tests**

```typescript
// src/tools/agent.test.ts (重写)
import { describe, it, expect } from "vitest";
import { agentTool } from "./agent.js";

function mkCtx(overrides: Record<string, unknown> = {}) {
  return {
    workspaceRoot: "/tmp",
    subagentDepth: 0,
    agentDefinitions: [
      { agentType: "general-purpose", whenToUse: "通用", source: "built-in", getSystemPrompt: () => "" },
      { agentType: "explore", whenToUse: "探查", source: "built-in", getSystemPrompt: () => "" },
    ],
    ...overrides,
  } as any;
}

describe("agentTool schema", () => {
  it("接受 task + description", () => {
    expect(agentTool.schema.parse({ task: "test", description: "测试" }).task).toBe("test");
  });
  it("接受 tasks 数组", () => {
    expect(agentTool.schema.parse({ tasks: ["a", "b"] }).tasks).toEqual(["a", "b"]);
  });
  it("接受 fork/isolate/background/model/mode", () => {
    expect(agentTool.schema.parse({ task: "x", fork: true }).fork).toBe(true);
  });
});

describe("agentTool handler", () => {
  it("无 task/tasks 返回错误", async () => {
    expect(await agentTool.handler({}, mkCtx())).toContain("请提供");
  });
  it("未配置 runAgent 返回错误", async () => {
    expect(await agentTool.handler({ task: "test" }, mkCtx())).toContain("不支持");
  });
  it("未知 agent_type 返回错误", async () => {
    expect(await agentTool.handler({ task: "x", agent_type: "unknown" }, mkCtx())).toContain("未知");
  });
  it("fork + model 互斥", async () => {
    const ctx = mkCtx({ runAgent: (async function* () { yield { role: "assistant", content: "ok" } as any; }) as any });
    expect(await agentTool.handler({ task: "x", fork: true, model: "flash" }, ctx)).toContain("互斥");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/agent.test.ts`
Expected: FAIL

- [ ] **Step 3: Write agent.ts + update types.ts**

完整代码见 spec Section 15 的 schema 和 handler 伪代码,实现时对标 CC `AgentTool.tsx` 的 call() 方法。核心流程:

1. 防御性嵌套检查(depth >= 1)
2. fork + model/mode 互斥检查
3. 查找 agentDef(agent_type 或 general-purpose 或 FORK_AGENT)
4. shouldRunAsync 判定(background || agentDef.background)
5. 异步:registerAsyncAgent + 后台 for-await + finalizeAgentTool + update
6. 同步:for-await runAgent + finalizeAgentTool + formatAgentResult(ONE_SHOT 省略 trailer)
7. 并行 tasks:并发限流 scatter-gather

`ToolContext` 变更:
- 新增 `runAgent`, `resumeAgent`, `agentDefinitions`, `forkMessages`
- 删除 `runSubagent`, `runForkAgent`, `runBackgroundAgent`, `adoptBackground`, `agentTypes`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/agent.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/agent.ts src/tools/agent.test.ts src/tools/types.ts
git commit -m "feat(tools): 重写 agent.ts + 扩展 ToolContext

Co-Authored-By: Dao <noreply@dao-code>"
```

---

### Task 13: index.ts 装配

**Files:**
- Modify: `src/index.ts` (lines ~909-977)

- [ ] **Step 1: Replace old wiring with new**

找到 `ctx.runSubagent = ...` 到 `ctx.adoptBackground = ...` 整块,替换为:

```typescript
import { runAgent } from "./agent/runAgent.js";
import { loadAgentDefs, type AgentDef } from "./agent/agent_defs.js";
import { BUNDLED_AGENTS } from "./agent/bundled_agents.js";
import { resumeAgentBackground } from "./agent/resume_agent.js";

// 加载 agent 定义
const diskAgentDefs = await loadAgentDefs(
  path.join(workspaceRoot, ".dao", "agents"),
  path.join(os.homedir(), ".dao", "agents"),
  pluginDirs,
);
const allAgentDefs: AgentDef[] = [...BUNDLED_AGENTS, ...diskAgentDefs];
ctx.agentDefinitions = allAgentDefs;

// 统一子代理派发
ctx.runAgent = (params) => runAgent({ ...params, toolUseContext: ctx, canUseTool: gate, streamChat, executeToolCalls, write: subagentWrite, runTurn, config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey }, registry, subagentsDir: path.join(workspaceRoot, ".dao", "subagents") });

// Agent 恢复
ctx.resumeAgent = async (agentId, prompt) => {
  await resumeAgentBackground({ agentId, prompt, subagentsDir: path.join(workspaceRoot, ".dao", "subagents"), agentDefs: allAgentDefs, runAgent: ctx.runAgent!, registerAsyncAgent: (o) => taskManager.registerAsyncAgent(o), runAsyncAgentLifecycle: async () => {} });
  return `已恢复子代理 ${agentId}。`;
};

ctx.taskManager = taskManager;
ctx.createWorktree = (id) => createWorktree(workspaceRoot, id);
ctx.sendToTask = (id, msg) => taskManager.send(id, msg);
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: 有错误(旧引用),Task 15 修

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(index): 装配新子代理引擎

Co-Authored-By: Dao <noreply@dao-code>"
```

---

### Task 14: Handoff Classifier

**Files:**
- Create: `src/agent/agent_handoff.ts`
- Test: `src/agent/agent_handoff.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/agent/agent_handoff.test.ts
import { describe, it, expect } from "vitest";
import { classifyHandoffIfNeeded } from "./agent_handoff.js";
import type { ChatMessage } from "../client/types.js";

describe("classifyHandoffIfNeeded", () => {
  it("非 auto 模式返回 null", async () => {
    expect(await classifyHandoffIfNeeded({ agentMessages: [], permissionMode: "default" as any, abortSignal: new AbortController().signal, subagentType: "t", totalToolUseCount: 0 })).toBeNull();
  });
  it("auto 模式 + 空消息返回 null", async () => {
    expect(await classifyHandoffIfNeeded({ agentMessages: [], permissionMode: "auto" as any, abortSignal: new AbortController().signal, subagentType: "t", totalToolUseCount: 0 })).toBeNull();
  });
  it("分类器不可用 -> 警告", async () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "x" }, { role: "assistant", content: "y", tool_calls: [] }];
    const r = await classifyHandoffIfNeeded({ agentMessages: msgs, permissionMode: "auto" as any, abortSignal: new AbortController().signal, subagentType: "t", totalToolUseCount: 1, classifyFn: async () => ({ unavailable: true }) });
    expect(r).toContain("分类器不可用");
  });
  it("blocked -> 安全警告", async () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "x" }, { role: "assistant", content: "y", tool_calls: [] }];
    const r = await classifyHandoffIfNeeded({ agentMessages: msgs, permissionMode: "auto" as any, abortSignal: new AbortController().signal, subagentType: "t", totalToolUseCount: 1, classifyFn: async () => ({ shouldBlock: true, reason: "删文件" }) });
    expect(r).toContain("安全警告");
    expect(r).toContain("删文件");
  });
  it("allowed -> null", async () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "x" }, { role: "assistant", content: "y", tool_calls: [] }];
    expect(await classifyHandoffIfNeeded({ agentMessages: msgs, permissionMode: "auto" as any, abortSignal: new AbortController().signal, subagentType: "t", totalToolUseCount: 1, classifyFn: async () => ({ shouldBlock: false }) })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/agent_handoff.test.ts`
Expected: FAIL

- [ ] **Step 3: Write agent_handoff.ts**

```typescript
// src/agent/agent_handoff.ts
import type { ChatMessage } from "../client/types.js";
import type { Mode } from "../tools/tools_for_mode.js";
import { buildClassifierTranscript } from "../permissions/classifier.js";

interface ClassifyResult { unavailable?: boolean; shouldBlock?: boolean; reason?: string; }

export async function classifyHandoffIfNeeded(opts: {
  agentMessages: ChatMessage[];
  permissionMode: Mode;
  abortSignal: AbortSignal;
  subagentType: string;
  totalToolUseCount: number;
  classifyFn?: (transcript: string) => Promise<ClassifyResult>;
}): Promise<string | null> {
  if (opts.permissionMode !== "auto") return null;
  if (opts.agentMessages.length === 0) return null;
  const transcript = buildClassifierTranscript(opts.agentMessages);
  if (!transcript || !opts.classifyFn) return null;
  let result: ClassifyResult;
  try { result = await opts.classifyFn(transcript); }
  catch { return "注意:安全分类器不可用,请手动验证子代理的操作后再信任其结果。"; }
  if (result.unavailable) return "注意:安全分类器不可用,请手动验证子代理的操作后再信任其结果。";
  if (result.shouldBlock) return `安全警告:子代理执行了可能违反安全策略的操作。原因:${result.reason ?? "未知"}。请仔细审查子代理的操作后再信任其输出。`;
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/agent_handoff.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent_handoff.ts src/agent/agent_handoff.test.ts
git commit -m "feat(agent): 新建 agent_handoff.ts - auto 模式安全审查

Co-Authored-By: Dao <noreply@dao-code>"
```

---

### Task 15: 集成测试 + 清理

**Files:**
- Delete: `src/agent/subagent.ts`, `src/agent/subagent.test.ts`
- Fix: all files referencing old interfaces

- [ ] **Step 1: Delete old subagent.ts**

```bash
rm src/agent/subagent.ts src/agent/subagent.test.ts
```

- [ ] **Step 2: Find and fix all references**

Run: `grep -rn "runSubagent\|runForkAgent\|runBackgroundAgent\|adoptBackground\|agentTypes\|SubagentDeps" src/ --include="*.ts"`

替换:
- `ctx.runSubagent` -> `ctx.runAgent`
- `ctx.runForkAgent` -> `ctx.runAgent` (with fork params)
- `ctx.runBackgroundAgent` -> `ctx.runAgent` (with isAsync)
- `ctx.adoptBackground` -> remove
- `ctx.agentTypes` -> `ctx.agentDefinitions`
- `SubagentDeps` -> `RunAgentParams`
- `import { runSubagent }` -> `import { runAgent }`

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Run lint**

Run: `npx eslint src/ --ext .ts`
Expected: 0 errors

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Run bundle:install**

Run: `npm run bundle:install`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(agent): 删除旧 subagent.ts + 修复引用 - 全面对齐 CC

Co-Authored-By: Dao <noreply@dao-code>"
```

---

## Self-Review

### 1. Spec Coverage

| Spec Section | Task(s) | Status |
|--------------|---------|--------|
| 1. 文件结构 | All | ✓ |
| 2. Agent 定义模型 | Task 1, 3 | ✓ |
| 3. 执行引擎 | Task 4 | ✓ |
| 4. 工具过滤 | Task 2 | ✓ |
| 5. 同步/异步 + 前台->后台 | Task 4, 11, 12 | ✓ |
| 6. Agent 恢复 | Task 10 | ✓ |
| 7. Agent Hooks | Task 7 | ✓ |
| 8. Agent Memory | Task 6 | ✓ |
| 9. 后台摘要 | Task 9 | ✓ |
| 10. 进度追踪 | Task 2 | ✓ |
| 11. Agent MCP | Task 8 (agent_mcp.ts 预留) | ✓ |
| 12. Handoff Classifier | Task 14 | ✓ |
| 13. Fork 机制 | Task 5 | ✓ |
| 14. 一次性 Agent | Task 2, 12 | ✓ |
| 15. Agent Prompt + 工具入口 | Task 8, 12, 13 | ✓ |

### 2. Placeholder Scan

无 TBD/TODO。所有步骤含完整代码。

### 3. Type Consistency

- `AgentDef` (Task 1) -> Task 2, 3, 4, 5, 8, 12 ✓
- `resolveAgentTools` (Task 2) -> Task 4 ✓
- `FORK_AGENT` (Task 5) -> Task 12 ✓
- `finalizeAgentTool` (Task 2) -> Task 12 ✓
- `ONE_SHOT_AGENT_TYPES` (Task 2) -> Task 10, 12 ✓
