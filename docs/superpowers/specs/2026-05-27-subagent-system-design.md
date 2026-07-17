# DAO 子代理系统全面对齐 Claude Code 设计文档

## 背景

DAO CODE 现有子代理系统是单文件 `agent/subagent.ts`(~80 行),`runSubagent(deps): Promise<string>` 接口,功能仅覆盖基础派发。Claude Code(CC)的子代理系统是 `tools/AgentTool/` 下 10+ 文件的完整框架,包含执行引擎、定义加载、工具过滤、恢复、Fork、Hooks、Memory、MCP、摘要、Handoff 等子系统。

本设计将 DAO 子代理系统全面对齐 CC,采用平移移植方案:按 CC 文件结构 1:1 拆分,字段名/函数签名/执行流程尽可能对齐,DAO 特有逻辑(缓存审计/profile 系统/中文 prompt)保留。

**不兼容变更**:现有 `AgentDef` 接口(5 字段)直接替换为新 schema,不做兼容映射。

## 1. 文件结构 + 模块职责

```
agent/
├── runAgent.ts          # 执行引擎(AsyncGenerator,对标 CC runAgent.ts)
├── agent_defs.ts        # Agent 定义加载/解析(扩展现有,不兼容替换)
├── bundled_agents.ts    # 内置 agent 定义(扩展现有,不兼容替换)
├── agent_tools.ts       # 工具过滤/结果汇总/进度追踪(对标 CC agentToolUtils.ts)
├── agent_prompt.ts      # 工具描述 prompt 生成(对标 CC prompt.ts)
├── resume_agent.ts      # 子代理恢复(对标 CC resumeAgent.ts)
├── fork_agent.ts        # Fork 机制(对标 CC forkSubagent.ts)
├── agent_memory.ts      # Agent 持久记忆(user/project/local scope)
├── agent_summary.ts     # 后台 agent 定期摘要(对标 CC agentSummary.ts)
├── agent_hooks.ts       # Agent 生命周期 hooks(SubagentStart/SubagentStop)
├── tasks.ts             # 后台任务管理器(扩展现有,加进度追踪)
├── worktree.ts          # git worktree 隔离(现有,基本不动)
├── loop.ts              # 回合循环(现有,对接 generator 模式)
├── ...其他现有文件不动
```

`tools/agent.ts` 保留为工具入口(schema + handler),对标 CC `AgentTool.tsx`。

**关键变更**:
- `runSubagent(deps): Promise<string>` → `runAgent(params): AsyncGenerator<Message, void>` — 执行引擎从返回字符串变为逐条 yield 消息
- `loop.ts` 新增 `runAgentTurn()`:消费 `runAgent` generator,逐条处理消息
- `index.ts` 中 `ctx.runSubagent` / `ctx.runForkAgent` / `ctx.runBackgroundAgent` 绑定逻辑全部重写,对接新引擎

### 删除的旧接口

- `ctx.runSubagent` → 删除(被 `ctx.runAgent` 替代)
- `ctx.runForkAgent` → 删除(fork 合并到 `runAgent` 参数)
- `ctx.runBackgroundAgent` → 删除(后台逻辑在 `tools/agent.ts` handler 内通过 `shouldRunAsync` 判定)
- `ctx.adoptBackground` → 删除(前台->后台无缝切换替代)
- `SubagentDeps` 接口 → 删除(被 `RunAgentParams` 替代)
- `agent/subagent.ts` → 删除(被 `agent/runAgent.ts` 替代)

## 2. Agent 定义模型

对齐 CC `BaseAgentDefinition`，DAO `AgentDef` 替换为完整 union 类型。

### 基础字段

```typescript
// agent/agent_defs.ts

export interface BaseAgentDef {
  agentType: string;              // 唯一标识(对齐 CC agentType)
  whenToUse: string;              // 给父 agent 看的"何时用"描述
  tools?: string[];               // 工具白名单(支持 '*' 通配)
  disallowedTools?: string[];     // 工具黑名单
  model?: string;                 // deepseek-v4-pro / deepseek-v4-flash / inherit
  permissionMode?: Mode;          // 子代理权限模式覆盖
  maxTurns?: number;              // 最大回合数
  skills?: string[];              // 预加载 skill 列表
  hooks?: AgentHooks;             // 生命周期 hooks(SubagentStart/SubagentStop)
  memory?: 'user' | 'project' | 'local';  // 持久记忆 scope
  background?: boolean;           // 强制后台运行
  isolation?: 'worktree';         // git worktree 隔离(CC 的 remote 不做)
  color?: string;                 // UI 颜色
  omitClaudeMd?: boolean;         // 省略 DAO.md 注入(省 token,只读 agent 用)
  initialPrompt?: string;         // 首轮前置 prompt
  mcpServers?: AgentMcpServerSpec[];      // agent 专属 MCP 服务器
  requiredMcpServers?: string[];          // 必须可用的 MCP 名称
  source: AgentSource;            // 来源标记
  filename?: string;              // 原始文件名(不含 .md)
  baseDir?: string;               // 加载目录
}

export type AgentSource = 'built-in' | 'userSettings' | 'projectSettings' | 'plugin';

// 内置 agent(硬编码,有 getSystemPrompt 闭包)
export interface BuiltInAgentDef extends BaseAgentDef {
  source: 'built-in';
  getSystemPrompt: (params: { toolUseContext: ToolContext }) => string;
}

// 自定义 agent(从 .dao/agents/*.md 加载)
export interface CustomAgentDef extends BaseAgentDef {
  source: 'userSettings' | 'projectSettings';
  getSystemPrompt: () => string;
}

// 插件 agent
export interface PluginAgentDef extends BaseAgentDef {
  source: 'plugin';
  getSystemPrompt: () => string;
  plugin: string;
}

export type AgentDef = BuiltInAgentDef | CustomAgentDef | PluginAgentDef;
```

### Frontmatter schema(.dao/agents/*.md)

字段名与 CC 完全一致:

```yaml
---
name: my-reviewer
description: 审查代码改动,给出改进建议
tools: "read_file, grep_files, exec_shell"
disallowedTools: "write_file, edit_file"
model: deepseek-v4-flash
permissionMode: plan
maxTurns: 50
skills: "code-review, simplify"
memory: project
background: true
isolation: worktree
color: red
omitClaudeMd: true
initialPrompt: "/code-review"
hooks:
  SubagentStart:
    - command: "echo 'agent starting'"
  SubagentStop:
    - command: "echo 'agent done'"
mcpServers:
  - slack
  - jira:
      command: "npx"
      args: ["-y", "@modelcontextprotocol/server-jira"]
---
你是代码审查 agent...
```

### 加载优先级

与 CC 一致:built-in < plugin < user(`~/.dao/agents/`) < project(`.dao/agents/`),同名后者覆盖前者。

### 内置 Agent

| Agent | model | tools | disallowedTools | memory | omitClaudeMd | 一次性 |
|-------|-------|-------|-----------------|--------|--------------|--------|
| general-purpose | inherit(省略) | undefined(全部) | 无 | project | false | 否 |
| explore | flash | 无白名单 | agent, edit_file, write_file, multi_edit, notebook_edit | 无 | true | 是 |
| plan | inherit | 无白名单 | agent, edit_file, write_file, multi_edit, notebook_edit, exec_shell, exec_shell_poll, exec_shell_kill | 无 | true | 是 |
| verify | inherit | 无白名单 | agent, edit_file, write_file, multi_edit, notebook_edit | 无 | false | 否 |

## 3. 执行引擎(runAgent.ts)

### 签名

```typescript
export async function* runAgent({
  agentDef,          // AgentDef(含 system prompt / 工具 / 模型 / 权限)
  promptMessages,    // 初始消息(用户 task)
  toolUseContext,    // 父代理的 ToolContext
  canUseTool,        // 权限检查函数
  isAsync,           // 是否异步(后台)
  forkContextMessages?,  // fork 路径:父的完整对话历史
  override?: {
    systemPrompt?,   // 覆盖 system prompt(fork 用父的)
    abortController?,// 覆盖 abort 控制器(异步=独立,同步=共享父的)
    agentId?,        // 覆盖 agent ID
  },
  model?,            // 调用级模型覆盖
  maxTurns?,         // 回合上限覆盖
  availableTools?,   // 预组装工具池
  useExactTools?,    // fork 路径:直接用父的工具池(缓存对齐)
  worktreePath?,     // worktree 隔离路径
  description?,      // 任务描述(持久化用)
  onCacheSafeParams?,// 缓存安全参数回调(后台摘要用)
  onQueryProgress?,  // 每条消息回调(活性检测用)
}): AsyncGenerator<Message, void>
```

### 执行流程(7 个阶段)

#### 阶段 1:参数解析
- 模型解析:`getAgentModel(agentDef.model, parentModel, modelOverride)` — 优先级:调用级 > agent 定义 > inherit
- 工具解析:`resolveAgentTools(agentDef, availableTools, isAsync)` — 白/黑名单 + 全局禁用 + 异步白名单三层过滤
- 权限模式:agentDef.permissionMode 覆盖父的(除非父是 bypass/auto)

#### 阶段 2:上下文构建
- System prompt:内置 agent 用 `getSystemPrompt()` 闭包;自定义用 frontmatter content;fork 用父的 rendered prompt
- `omitClaudeMd=true` 的 agent 省略 DAO.md 注入(Explore/Plan)
- Explore/Plan 省略 gitStatus
- fork 路径:克隆父的 readFileState;非 fork 新建
- 消息组装:`[...forkContextMessages, ...promptMessages]`

#### 阶段 3:Agent 级资源初始化
- **Hooks**:agentDef.hooks 注册到 session scope,执行 SubagentStart,收集 additionalContext
- **Skills**:agentDef.skills 预加载,作为 initial message 注入
- **Memory**:agentDef.memory 加载持久记忆 prompt,追加到 system prompt;强制注入 write_file/edit_file/read_file 工具
- **MCP**:agentDef.mcpServers 连接专属 MCP,合并到工具池

#### 阶段 4:会话创建
```typescript
const sub = new Session(agentSystemPrompt, resolvedModel);
sub.mode = agentPermissionMode;
sub.messages = initialMessages;
```
创建 agentToolUseContext:子代理独立的工具上下文(独立 readFiles、独立 abortController)

#### 阶段 5:查询循环
```typescript
for await (const message of runTurn({ session: sub, ... })) {
  onQueryProgress?.();
  yield message;
  // sidechain 转录持久化(逐条写 .dao/subagents/<agentId>.jsonl)
}
```

#### 阶段 6:回调
- 内置 agent 的 `callback()`(如有)

#### 阶段 7:清理(finally)
- MCP 连接清理
- Hooks 注销(执行 SubagentStop)
- readFileState 释放
- shell tasks 清理(子代理派生的后台 shell)
- todos 清理(子代理的 TodoWrite 残留)

### 关键差异 vs 现有 runSubagent

| 维度 | 现有 runSubagent | 新 runAgent |
|------|-----------------|-------------|
| 返回值 | `Promise<string>` | `AsyncGenerator<Message>` |
| 消息流 | 内部消耗,只返回最终文本 | 逐条 yield,上层可见 |
| 进度追踪 | 无 | 上层可读每条消息,驱动进度更新 |
| 前台->后台切换 | 不支持(只有 60s 超时) | 上层 race generator.next() vs backgroundSignal |
| fork | 特殊参数 forkMessages | 统一参数 forkContextMessages |
| Agent 资源 | 无 | hooks/skills/memory/mcp 初始化+清理 |
| 转录 | 跑完一次性写 | 逐条写(可恢复) |

## 4. 工具过滤机制

### 三层过滤管线

```
输入: 全部注册工具
  │
  ▼ ① 全局禁用(ALL_AGENT_DISALLOWED_TOOLS)
  │   agent, ask_user, task_stop
  │
  ▼ ② 自定义 Agent 额外禁用(CUSTOM_AGENT_DISALLOWED_TOOLS)
  │   非内置 agent 额外禁用(继承全部全局禁用)
  │
  ▼ ③ 异步白名单(ASYNC_AGENT_ALLOWED_TOOLS)
  │   后台 agent 只能用这些工具(无 UI 交互能力)
  │
  ▼ ④ Agent 定义级过滤
  │   tools 白名单 ∩ 剩余工具
  │   disallowedTools 黑名单 - 排除
  │
  输出: 该 agent 最终可用的工具池
```

### DAO 工具禁用/允许清单

```typescript
// agent/agent_tools.ts

// ① 所有子代理禁用
export const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  "agent",       // 子代理不能再派子代理(DAO 与 CC 非 ant 模式一致)
  "ask_user",    // 子代理不能向用户提问
  "task_stop",   // 子代理不能停别的任务
]);

// ② 自定义 agent 额外禁用(内置 agent 信任,自定义不信任)
export const CUSTOM_AGENT_DISALLOWED_TOOLS = new Set([
  ...ALL_AGENT_DISALLOWED_TOOLS,
]);

// ③ 异步(后台)agent 工具白名单
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
```

### resolveAgentTools 函数

```typescript
export function resolveAgentTools(
  agentDef: Pick<AgentDef, 'tools' | 'disallowedTools' | 'source' | 'permissionMode'>,
  availableTools: ToolRegistry,
  isAsync: boolean,
): { resolvedTools: ToolRegistry; hasWildcard: boolean }
```

### filterToolsForAgent 辅助函数

```typescript
export function filterToolsForAgent({
  tools, isBuiltIn, isAsync, permissionMode?,
}): ToolRegistry
```

## 5. 同步/异步执行模型 + 前台->后台无缝切换

### 整体流程

```
tools/agent.ts handler 调用
  │
  ├─ shouldRunAsync = background || agentDef.background || forceAsync
  │
  ├─── 异步路径(shouldRunAsync=true)
  │    ├── registerAsyncAgent() -> 注册后台任务 + 独立 AbortController
  │    ├── runAsyncAgentLifecycle() 后台跑
  │    │   ├── for await (msg of runAgent(...)) 逐条消费
  │    │   ├── 实时更新进度(token/工具计数/活动描述)
  │    │   └── 完成 -> enqueueAgentNotification()
  │    └── 立即返回 { status: "async_launched", agentId, outputFile }
  │
  └─── 同步路径(shouldRunAsync=false)
       ├── registerAgentForeground() -> 注册前台任务(可被中途转后台)
       ├── race(generator.next() vs backgroundSignal)
       │   ├── 消息到达 -> 转发给父 agent(onProgress)
       │   └── 被转后台 -> 切入异步路径,返回 async_launched
       ├── 2s 后显示"可转后台"提示(UI hint)
       └── 完成 -> 返回 { status: "completed", content, ... }
```

### 前台->后台无缝切换(核心机制)

```typescript
// tools/agent.ts handler 内(同步路径)

const fg = registerAgentForeground({ agentId, description, ... });

const iterator = runAgent({ ... })[Symbol.asyncIterator]();

while (true) {
  const raceResult = await Promise.race([
    iterator.next().then(r => ({ type: 'message', result: r })),
    fg.backgroundSignal.then(() => ({ type: 'background' })),
  ]);

  if (raceResult.type === 'background') {
    // 切入后台:继续消费 generator,但不再阻塞父代理
    void runAsyncAgentLifecycle({
      taskId: fg.taskId,
      makeStream: () => iterator,  // 复用同一个 iterator
      ...
    });
    return { status: 'async_launched', agentId: fg.taskId, ... };
  }

  if (raceResult.result.done) break;
  const msg = raceResult.result.value;
  onProgress?.(msg);
}
```

### Auto-background 触发

```typescript
export function registerAgentForeground(opts: {
  agentId: string;
  description: string;
  setAppState: SetAppState;
  autoBackgroundMs?: number;  // 默认 60s
}): {
  taskId: string;
  backgroundSignal: Promise<void>;
  cancelAutoBackground: () => void;
}
```

- 60s 超时自动触发 backgroundSignal
- 用户也可手动按快捷键转后台
- 转后台后,前台立即返回 async_launched,后台继续跑

### runAsyncAgentLifecycle

```typescript
export async function runAsyncAgentLifecycle({
  taskId, abortController, makeStream, metadata, description,
  toolUseContext, rootSetAppState, agentIdForCleanup,
  enableSummarization, getWorktreeResult,
}): Promise<void> {
  const tracker = createProgressTracker();
  for await (const message of makeStream()) {
    updateProgressFromMessage(tracker, message);
    updateAsyncAgentProgress(taskId, getProgressUpdate(tracker), rootSetAppState);
  }
  // 完成 -> finalizeAgentTool -> completeAsyncAgent -> enqueueAgentNotification
  // 失败 -> failAsyncAgent -> enqueueAgentNotification
  // abort -> killAsyncAgent -> extractPartialResult -> enqueueAgentNotification
}
```

## 6. Agent 恢复(Resume)

### 转录持久化

逐条写入,带 agentId 和 parentUuid 链:

```
.dao/subagents/
├── <agentId>.jsonl          # 逐条消息(每行一条,含 uuid/parentUuid)
├── <agentId>.meta.json      # 元数据(agentType/description/model/worktreePath/startTime)
```

```typescript
export async function recordSidechainMessage(
  agentId: string,
  message: ChatMessage,
  parentUuid?: string,
): Promise<void>  // 追加一行 JSON,fire-and-forget

export async function writeAgentMetadata(
  agentId: string,
  meta: { agentType: string; description?: string; worktreePath?: string; model?: string },
): Promise<void>
```

### Resume 流程

```typescript
// agent/resume_agent.ts

export async function resumeAgentBackground({
  agentId, prompt, toolUseContext, canUseTool,
}): Promise<{ agentId: string; description: string; outputFile: string }> {
  // 1. 读取转录 + 元数据
  // 2. 过滤不完整消息(未配对的 tool_use / 空 assistant)
  // 3. 恢复 worktree(如 meta.worktreePath 仍存在)
  // 4. 查找 agent 定义(按 meta.agentType)
  // 5. 构建恢复消息:[...resumedMessages, createUserMessage(prompt)]
  // 6. 注册后台任务 + 走 runAsyncAgentLifecycle
}
```

### SendMessage 对接

`task_send` 工具扩展:如果目标 agent 已结束(status=completed),改为走 resume 流程。

`ToolContext` 新增:`resumeAgent?: (agentId: string, prompt: string) => Promise<string>`

### 一次性 Agent 不 resume

explore 和 plan 不支持 resume。SendMessage 对这些类型直接拒绝。

## 7. Agent Hooks

### Hook 事件

| 事件 | 触发时机 |
|------|---------|
| `SubagentStart` | 子代理会话创建后、首轮查询前 |
| `SubagentStop` | 子代理会话结束(完成/失败/取消) |

### 实现

```typescript
// agent/agent_hooks.ts

export interface AgentHooks {
  SubagentStart?: HookCommand[];
  SubagentStop?: HookCommand[];
}

export function registerAgentHooks(
  setAppState: SetAppState, agentId: string, hooks: AgentHooks,
): void

export function clearAgentHooks(
  setAppState: SetAppState, agentId: string,
): void
```

### 执行时机(在 runAgent.ts 中)

- 阶段 3:注册 hooks,执行 SubagentStart,收集 additionalContext 作为 initial message 注入
- 阶段 7(finally):执行 SubagentStop,清理 hooks

复用 DAO 现有 `runHooks()` 执行机制。`PreToolUse`/`PostToolUse` 在子代理内自然生效(通过 `ctx.preToolHook`/`ctx.postToolHook` 注入)。

## 8. Agent Memory

### Scope 层级

| Scope | 存储路径 | 含义 |
|-------|---------|------|
| `user` | `~/.dao/agents/memory/<agentType>/` | 跨项目,agent 的全局记忆 |
| `project` | `.dao/agents/memory/<agentType>/` | 本项目内,agent 的项目记忆 |
| `local` | `.dao/agents/memory/<agentType>/local/` | 本地(不入 git) |

### 存储格式

```
~/.dao/agents/memory/<agentType>/
├── memory.md          # 记忆正文(agent 可读可写)
├── snapshot.json      # 快照(时间戳 + 内容摘要,跨项目同步用)
```

`memory.md` 是纯 markdown,agent 通过 read_file/write_file/edit_file 直接读写。

### Memory 注入

```typescript
export function loadAgentMemoryPrompt(agentType: string, scope: AgentMemoryScope): string
```

在 runAgent 阶段 2 追加到 system prompt。memory agent 强制注入 write_file/edit_file/read_file 工具(即使 agent 的 tools 白名单没列)。

### 内置 Agent Memory 配置

- general-purpose: `memory: project`
- explore: 不设
- plan: 不设
- verify: 不设

### Snapshot 机制

Phase 1 只实现读写,Snapshot 同步留接口不实现(写 snapshot.json,但不做自动跨项目同步)。

## 9. 后台 Agent 摘要

### 机制

后台 agent 每 30s 用 flash 模型对已积累的对话做摘要,更新任务的 `summary` 字段。

```typescript
// agent/agent_summary.ts

export function startAgentSummarization(
  taskId: string, agentId: string,
  params: CacheSafeParams, setAppState: SetAppState,
): { stop: () => void }
```

### 摘要内容

```
正在: 跑测试套件
已用: 12 工具调用 / 4500 tokens
最近: npm test -- 第 3 个测试失败,正在排查
```

### 触发条件

- 仅后台 agent(同步 agent 不摘要)
- 后台 agent 一律开摘要
- 摘要用模型固定 `deepseek-v4-flash`

### 生命周期

```
runAsyncAgentLifecycle()
  ├── onCacheSafeParams 回调 -> startAgentSummarization()
  ├── for await (msg of stream) { ... }
  ├── stopSummarization()  // 循环结束后停止
  └── finally: stopSummarization?.()
```

### BgTask 扩展

```typescript
export interface BgTask {
  // ...现有字段
  summary?: string;        // 最新摘要
  messages?: ChatMessage[]; // 实时消息(UI/SDK 用)
}
```

## 10. 进度追踪

### 数据结构

```typescript
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
```

### 活动描述解析

把 tool_result 翻译成人类可读描述:
- read_file → "读取文件 <path>"
- grep_files → "搜索 '<pattern>'"
- exec_shell → "执行命令 <command 前 60 字符>"
- write_file → "写入文件 <path>"
- edit_file → "编辑文件 <path>"
- 默认 → "使用 <tool>"

### 接入点

- 同步路径:`onProgress` 回调实时驱动 UI
- 异步路径:`updateAsyncAgentProgress` 更新 AppState
- 结束时:`finalizeAgentTool` 返回结构化结果(agentId/content/totalTokens/totalToolUseCount/totalDurationMs)

## 11. Agent 专属 MCP 服务器

### Frontmatter 定义

两种形式:
- **字符串引用**:按名查找已配置的 MCP server(复用连接)
- **内联定义**:agent 专属,启动时新建连接、结束时清理

```typescript
export type AgentMcpServerSpec =
  | string                              // 引用名
  | { [name: string]: McpServerConfig }; // 内联定义

export async function initializeAgentMcpServers(
  agentDef: AgentDef,
  parentClients: McpConnection[],
): Promise<{
  clients: McpConnection[];
  tools: Tool[];
  cleanup: () => Promise<void>;
}>
```

### 接入点

runAgent 阶段 3 初始化,阶段 7 清理。只清理内联定义的连接,引用连接由父管理。

`requiredMcpServers` 字段用于过滤:agent 要求的 MCP server 未配置/未连接时,该 agent 不出现在可用列表中。

## 12. Handoff Classifier

### 机制

auto 权限模式下,子代理结束后、结果交回父代理前,用 flash 分类器审查子代理输出是否安全。

```
子代理完成
  └── finalizeAgentTool()
      └── if (permissionMode === 'auto')
          └── classifyHandoffIfNeeded()
              ├── 构建 transcript(子代理消息 + 工具调用记录)
              ├── 调用 flash 分类器
              ├── 判定: allowed / blocked / unavailable
              └── 返回(可能带警告的)结果
```

### 判定逻辑

- `allowed` → 正常返回结果
- `blocked` → 结果前插入安全警告
- `unavailable` → 结果前插入"分类器不可用"提示(fail-closed 但不阻塞)

### 复用现有分类器

DAO 已有 auto 模式分类器(`src/approval/classifier.ts`)。Handoff classifier 复用同一 flash 模型调用通道和 fail-closed 策略,区别是:现有分类器判断单个工具调用;handoff 判断整段子代理 transcript。

### 触发条件

仅 `permissionMode === 'auto'` 时触发,其他模式直接返回结果。

## 13. Fork 机制

### Fork Agent 定义

```typescript
// agent/fork_agent.ts

export const FORK_AGENT: BuiltInAgentDef = {
  agentType: 'fork',
  whenToUse: '隐式 fork - 继承父代理完整上下文。不可通过 agent_type 指定;由 fork=true 触发。',
  tools: undefined,           // useExactTools 直接拿父的工具池
  model: 'inherit',
  source: 'built-in',
  getSystemPrompt: () => '',  // 实际用父的 rendered system prompt
};
```

### 防递归 Fork

检测 `<fork-directive>` 标记,fork 子不能再 fork。

### buildForkedMessages

1. 截取父消息前缀(剪掉尾部未配对的 assistant/tool)
2. 构建 directive 消息(中文,结构化输出格式:范围/结果/关键文件/改动文件/问题)
3. 返回 `[...prefix, directiveMessage]`

### runAgent 中的 Fork 路径

- 用父的 rendered system prompt(字节级一致,缓存命中)
- 用父的完整工具池(useExactTools = true)
- 模型继承父的
- 消息:`[...forkPrefix, forkDirective]`

### 与 CC 的差异

| 维度 | CC | DAO |
|------|-----|-----|
| 触发方式 | 省略 subagent_type(实验 gate) | `fork: true` 参数(显式) |
| 全部异步 | 是(forceAsync) | 否,可前台可后台 |
| directive 语言 | 英文 | 中文 |

### Worktree + Fork

fork 子在 worktree 里运行时注入路径翻译提示(翻译父 cwd 路径到 worktree 路径,编辑前重读文件)。

## 14. 一次性 Agent 优化

### 一次性 Agent 集合

```typescript
export const ONE_SHOT_AGENT_TYPES = new Set(['explore', 'plan']);
```

### 优化点

1. **返回结果省略 trailer**:不附 agentId/usage trailer(省 token)
2. **禁止 resume**:resumeAgent 直接拒绝
3. **禁止 SendMessage**:task_send 直接拒绝
4. **省略 CLAUDE.md / gitStatus**:`omitClaudeMd: true`

## 15. Agent Prompt 生成 + tools/agent.ts 工具入口

### Agent Prompt 生成

```typescript
// agent/agent_prompt.ts

export function getAgentPrompt(
  agentDefs: AgentDef[],
  allowedAgentTypes?: string[],
): string
```

生成 `agent` 工具的描述文本,含可用 agent 列表、用法说明、何时用/何时不该用、写 prompt 指引。

### tools/agent.ts Schema 扩展

```typescript
export const agentTool = defineTool({
  name: "agent",
  capability: "plan",
  approval: "auto",
  schema: z.object({
    description: z.string().min(1).optional(),
    task: z.string().min(1).optional(),
    tasks: z.array(z.string().min(1)).min(1).max(20).optional(),
    background: z.boolean().optional(),
    agent_type: z.string().optional(),
    isolate: z.boolean().optional(),
    fork: z.boolean().optional(),
    model: z.string().optional(),
    mode: z.enum(["normal", "plan"]).optional(),
  }),
  handler: async (args, ctx) => {
    // 1. 嵌套深度检查(2 层上限)
    // 2. agent_type 校验 + 查找 AgentDef
    // 3. fork 路由(fork=true -> FORK_AGENT,与 agent_type/model/mode 互斥)
    // 4. resolveAgentTools(工具过滤)
    // 5. worktree 隔离(isolate=true)
    // 6. shouldRunAsync 判定
    //    - 异步 -> registerAsyncAgent + runAsyncAgentLifecycle,返回 async_launched
    //    - 同步 -> race(generator vs backgroundSignal),前台->后台无缝切换
    // 7. 同步完成 -> finalizeAgentTool -> classifyHandoffIfNeeded -> formatAgentResult
    // 8. 并行 tasks -> 并发限流 scatter-gather(保留现有)
  },
});
```

### ToolContext 变更

```typescript
export interface ToolContext {
  // ...现有字段

  // 子代理派发(重写为返回 AsyncGenerator)
  runAgent?: (params: RunAgentParams) => AsyncGenerator<ChatMessage, void>;

  // Agent 恢复
  resumeAgent?: (agentId: string, prompt: string) => Promise<string>;

  // 可用 agent 定义(替代现有 agentTypes)
  agentDefinitions?: AgentDef[];

  // ...其余不变
}
```

### index.ts 装配

现有 `ctx.runSubagent` / `ctx.runForkAgent` / `ctx.runBackgroundAgent` 统一为 `ctx.runAgent`:

```typescript
ctx.runAgent = (params: RunAgentParams): AsyncGenerator<ChatMessage, void> => {
  return runAgent({
    ...params,
    toolUseContext: ctx,
    canUseTool: gate,
    streamChat,
    executeToolCalls,
    write: subagentWrite,
    runTurn,
  });
};

ctx.resumeAgent = async (agentId, prompt) => {
  const result = await resumeAgentBackground({
    agentId, prompt, toolUseContext: ctx, canUseTool: gate,
  });
  return `已恢复子代理 ${agentId}。`;
};
```

## 模块依赖关系

```
tools/agent.ts (工具入口)
  ├── agent/agent_prompt.ts (描述 prompt)
  ├── agent/agent_defs.ts (定义加载)
  │   └── agent/bundled_agents.ts (内置 agent)
  ├── agent/agent_tools.ts (工具过滤/结果汇总/进度追踪/handoff)
  ├── agent/runAgent.ts (执行引擎)
  │   ├── agent/agent_hooks.ts (生命周期 hooks)
  │   ├── agent/agent_memory.ts (持久记忆)
  │   ├── agent/agent_mcp.ts (专属 MCP) [预留接口]
  │   ├── agent/fork_agent.ts (Fork 机制)
  │   ├── agent/agent_summary.ts (后台摘要)
  │   └── agent/worktree.ts (worktree 隔离)
  ├── agent/resume_agent.ts (恢复)
  └── agent/tasks.ts (后台任务管理器)
```
