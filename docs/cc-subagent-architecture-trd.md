# Claude Code 子代理架构技术参考文档 (TRD)

> 基于对 `refs/claude-code/src/` 源码的逐文件阅读。所有引用均标注文件路径与行号。

## 1. 总体架构

CC 的子代理系统由以下文件构成核心:

```
tools/AgentTool/
├── AgentTool.tsx          -- 入口: schema、调用编排、同步/异步分叉、前台转后台
├── agentToolUtils.ts      -- 工具过滤(resolveAgentTools)、handoff 分类、finalize、runAsyncAgentLifecycle
├── runAgent.ts            -- 子代理上下文构建、system prompt 组装、查询循环
├── forkSubagent.ts        -- fork 路径: buildForkedMessages、buildChildMessage、FORK_AGENT 定义
├── builtInAgents.ts       -- 内置 agent 注册表
├── built-in/              -- 各内置 agent 的定义文件
│   ├── generalPurposeAgent.ts
│   ├── exploreAgent.ts
│   ├── planAgent.ts
│   ├── verificationAgent.ts
│   └── ...
├── loadAgentsDir.ts       -- 自定义 agent 从 .claude/agents/*.md 解析(frontmatter + body)
├── prompt.ts              -- 工具描述生成(getPrompt): agent 列表 + whenToUse + 示例
├── resumeAgent.ts         -- 后台 agent resume: 从磁盘转录重建
└── constants.ts           -- 常量
tasks/LocalAgentTask/
└── LocalAgentTask.tsx     -- 任务注册(registerAsyncAgent/registerAgentForeground)、通知(enqueueAgentNotification)、消息队列(queuePendingMessage/drainPendingMessages)
utils/
├── forkedAgent.ts         -- CacheSafeParams 类型定义、createSubagentContext、forked query loop
├── worktree.ts            -- git worktree 创建/清理(sparse-checkout、.worktreeinclude、hooks)
├── messageQueueManager.ts -- 统一命令队列(commandQueue): 优先级 dequeue
├── attachments.ts         -- getAgentPendingMessageAttachments: 子代理工具回合边界 drain
└── permissions/
    ├── yoloClassifier.ts   -- 两阶段 XML 安全分类器(stage1 fast + stage2 thinking)
    ├── denialTracking.ts   -- 熔断: 连续 3 次或总计 20 次拒绝 -> 回退人工
    └── permissions.ts      -- 权限决策引擎,集成分类器与熔断
constants/
├── tools.ts               -- ALL_AGENT_DISALLOWED_TOOLS、ASYNC_AGENT_ALLOWED_TOOLS
└── xml.ts                 -- XML 标签常量
```

## 2. 内置 Agent 类型

### 2.1 注册与优先级

`builtInAgents.ts:22-72` `getBuiltInAgents()` 返回内置 agent 列表。优先级覆盖关系(`loadAgentsDir.ts:193-209`):

```
built-in > plugin > userSettings > projectSettings > localSettings > flagSettings > policySettings
```

### 2.2 各 Agent 定义

| Agent | agentType | model | tools | disallowedTools | 特殊属性 | 文件 |
|-------|-----------|-------|-------|-----------------|----------|------|
| general-purpose | `general-purpose` | 省略(inherit) | `['*']` | 无 | - | `built-in/generalPurposeAgent.ts` |
| Explore | `Explore` | ant=inherit / external=haiku | 省略(= `['*']`) | Agent, ExitPlanMode, Edit, Write, NotebookEdit | `omitClaudeMd: true` | `built-in/exploreAgent.ts` |
| Plan | `Plan` | inherit | = Explore.tools | Agent, ExitPlanMode, Edit, Write, NotebookEdit | `omitClaudeMd: true` | `built-in/planAgent.ts` |
| verification | `verification` | inherit | 省略 | Agent, ExitPlanMode, Edit, Write, NotebookEdit | `background: true`, `color: 'red'`, `criticalSystemReminder_EXPERIMENTAL` | `built-in/verificationAgent.ts` |
| fork (合成) | `fork` | inherit | `['*']` | 无 | 不注册到 builtInAgents; 由 `fork=true` 触发 | `forkSubagent.ts:60-71` |

### 2.3 system prompt

每个内置 agent 的 `getSystemPrompt()` 返回独立完整 prompt, **不以主 system prompt 为前缀** (`runAgent.ts:508-518`):

- general-purpose: ~300 字, "You are an agent for Claude Code..." + 搜索/分析指引
- Explore: ~400 字, READ-ONLY 声明 + 搜索工具指引 + 并行调用建议
- Plan: ~700 字, 架构规划流程 + "Critical Files" 输出格式
- verification: ~2000 字, 对抗性验证策略 + 反自我合理化清单(6 条具体借口及反制) + VERDICT 输出格式 + adversarial probe 要求
- fork: 空字符串(用 `override.systemPrompt` 传父的 rendered prompt)

`runAgent.ts:508-518` system prompt 组装逻辑:
```typescript
const agentSystemPrompt = override?.systemPrompt       // fork 路径: 父的 rendered prompt
  ? override.systemPrompt
  : asSystemPrompt(
      await getAgentSystemPrompt(                       // 普通路径: agent 自己的 prompt + env 增强
        agentDefinition, toolUseContext, resolvedAgentModel,
        additionalWorkingDirectories, resolvedTools,
      ),
    );
```

`getAgentSystemPrompt()` (`runAgent.ts:890-932`) 构建流程: `agentDef.getSystemPrompt()` -> `enhanceSystemPromptWithEnvDetails()` 追加环境信息(cwd/platform/gitStatus/工具列表)。Explore/Plan 额外设 `omitClaudeMd=true`(`exploreAgent.ts:81`, `planAgent.ts:90`), 不注入 CLAUDE.md 的 commit/PR/lint 规则。

verification agent 额外有 `criticalSystemReminder_EXPERIMENTAL` (`verificationAgent.ts:150-151`), 在每轮 user turn 前重新注入: "CRITICAL: This is a VERIFICATION-ONLY task..."

### 2.4 自定义 Agent

从 `.claude/agents/*.md` 解析 (`loadAgentsDir.ts:73-99` AgentJsonSchema)。frontmatter 字段:

```yaml
description: <whenToUse>         # 必填
tools: [list]                    # 可选, 省略 = ['*']
disallowedTools: [list]          # 可选
prompt: <systemPrompt body>      # 必填
model: <model alias 或 inherit>  # 可选
effort: <effort level>           # 可选
permissionMode: <mode>           # 可选
mcpServers: [spec]               # 可选
hooks: <hooks config>            # 可选
maxTurns: <int>                  # 可选
skills: [skill names]            # 可选, 预加载
initialPrompt: <string>          # 可选, 前置到首条 user turn
memory: user|project|local       # 可选, 持久记忆 scope
background: true                 # 可选, 强制后台
isolation: worktree|remote       # 可选, ant 支持 remote
```

## 3. 工具过滤机制

### 3.1 三层过滤

`agentToolUtils.ts:70-116` `filterToolsForAgent()`:

```
层 1: ALL_AGENT_DISALLOWED_TOOLS (所有子代理, 含 built-in)
      → TaskOutput, ExitPlanMode, EnterPlanMode, Agent(非 ant), AskUser, TaskStop, Workflow

层 2: CUSTOM_AGENT_DISALLOWED_TOOLS (仅自定义 agent)
      → = ALL_AGENT_DISALLOWED_TOOLS (当前无额外工具)

层 3: ASYNC_AGENT_ALLOWED_TOOLS (仅异步/后台子代理)
      → 白名单: Read, Write, Edit, NotebookEdit, Bash/PowerShell, Grep, Glob,
        WebSearch, WebFetch, TodoWrite, Skill, ToolSearch, EnterWorktree, ExitWorktree,
        SyntheticOutput
      → 不在白名单的工具对后台子代理不可用
```

MCP 工具(`mcp__` 前缀)对所有 agent 放行 (`agentToolUtils.ts:83-84`)。

### 3.2 递归防护

`constants/tools.ts:36-46`:
```typescript
export const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  TASK_OUTPUT_TOOL_NAME,
  EXIT_PLAN_MODE_V2_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  // Allow Agent tool for agents when user is ant (enables nested agents)
  ...(process.env.USER_TYPE === 'ant' ? [] : [AGENT_TOOL_NAME]),
  ASK_USER_QUESTION_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  ...(feature('WORKFLOW_SCRIPTS') ? [WORKFLOW_TOOL_NAME] : []),
])
```

**关键**: `USER_TYPE === 'ant'` 时 Agent 工具不被全局禁用 -- Anthropic 内部用户可以嵌套子代理。外部用户(`external`)则硬性 1 层, 不能套娃。

### 3.3 Agent 工具携带 allowedAgentTypes

`agentToolUtils.ts:186-204`: 自定义 agent 的 `tools` 列表里可以写 `Agent(worker, researcher)` 来限制可派发的子代理类型。`resolveAgentTools()` 解析括号内的逗号分隔列表, 存为 `allowedAgentTypes`。

### 3.4 fork 路径: useExactTools

`AgentTool.tsx:627-632`:
```typescript
availableTools: isForkPath ? toolUseContext.options.tools : workerTools,
forkContextMessages: isForkPath ? toolUseContext.messages : undefined,
...(isForkPath && { useExactTools: true }),
```

`runAgent.ts:500-502`:
```typescript
const resolvedTools = useExactTools
  ? availableTools          // fork: 直接用父的完整工具池, 不过 filterToolsForAgent
  : resolveAgentTools(agentDefinition, availableTools, isAsync).resolvedTools;
```

fork 子代理**跳过三层过滤**, 直接继承父的精确工具池 -- 目的是工具 schema 字节一致, 最大化前缀缓存命中。防递归不靠工具排除, 而靠 `isInForkChild()` 检测 `<fork-boilerplate>` 标签 (`forkSubagent.ts:78-89`)。

## 4. 同步/异步执行模型

### 4.1 执行路径选择

`AgentTool.tsx:567`:
```typescript
const shouldRunAsync = (run_in_background === true
  || selectedAgent.background === true
  || isCoordinator
  || forceAsync               // isForkSubagentEnabled(): fork 模式强制全异步
  || assistantForceAsync      // KAIROS: assistant 模式强制全异步
  || (proactiveModule?.isProactiveActive() ?? false)
) && !isBackgroundTasksDisabled;
```

### 4.2 同步路径(前台阻塞)

`AgentTool.tsx:808-1261`:

1. `registerAgentForeground()` 注册前台任务 (`LocalAgentTask.tsx:526-614`), 创建 `backgroundSignal` Promise + `autoBackgroundMs` 定时器
2. 获取 `runAgent()` 的 async iterator
3. 进入 `while(true)` 循环, `Promise.race` 在 `iterator.next()` 和 `backgroundSignal` 之间竞争
4. 2 秒后显示 `BackgroundHint` UI (`PROGRESS_THRESHOLD_MS = 2000`, `AgentTool.tsx:63`)
5. 每条消息: 更新 progress tracker、转发 bash_progress、推送 SDK 事件
6. 收到 `done` -> `finalizeAgentTool()` -> handoff 分类(可选) -> 返回结果
7. `finally`: 清理前台任务注册、worktree、skills

### 4.3 自动转后台

`getAutoBackgroundMs()` (`AgentTool.tsx:72-77`):
```typescript
function getAutoBackgroundMs(): number {
  if (isEnvTruthy(process.env.CLAUDE_AUTO_BACKGROUND_TASKS)
      || getFeatureValue_CACHED_MAY_BE_STALE('tengu_auto_background_agents', false)) {
    return 120_000;  // 2 分钟
  }
  return 0;  // 不自动转
}
```

默认**不自动转**。只有环境变量 `CLAUDE_AUTO_BACKGROUND_TASKS` 或 GrowthBook flag `tengu_auto_background_agents` 开启时, 前台子代理跑超过 120 秒自动转后台。

转后台流程 (`AgentTool.tsx:897-1052`):
1. `backgroundSignal` resolve -> `wasBackgrounded = true`
2. 停止前台 summarization
3. `await agentIterator.return(undefined)` 清理前台 iterator(MCP 连接、hooks 等), 带超时保护
4. **重新调用 `runAgent()`** -- 不是复用同一个 iterator(DAO 的做法), 而是重新启动一个 `isAsync: true` 的 runAgent, 传入已有的 `agentMessages` 作为进度
5. 从已有消息重建 progress tracker
6. 跑完后 `completeAsyncAgent` -> `classifyHandoffIfNeeded` -> `enqueueAgentNotification`
7. 立即返回 `{ status: 'async_launched' }` 给父代理

### 4.4 异步路径(后台启动)

`AgentTool.tsx:686-764`:

1. `registerAsyncAgent()` (`LocalAgentTask.tsx:466-515`) 创建任务状态, `isBackgrounded: true`, 独立 AbortController(不随父 ESC 死)
2. 如果有 `name` 参数, 注册到 `agentNameRegistry` 供 SendMessage 路由
3. `void runAsyncAgentLifecycle(...)` fire-and-forget
4. 立即返回 `{ status: 'async_launched', agentId, outputFile }`

### 4.5 runAsyncAgentLifecycle

`agentToolUtils.ts:508-686`:

```
try:
  tracker = createProgressTracker()
  onCacheSafeParams = enableSummarization ? startAgentSummarization(...) : undefined
  
  for await (message of makeStream(onCacheSafeParams)):
    agentMessages.push(message)
    // retain 模式: 实时追加到 task.messages 供 UI 查看
    if (task.retain) appendMessageToLocalAgent(taskId, message)
    updateProgressFromMessage(tracker, message, ...)
    updateAsyncAgentProgress(taskId, ...)
    emitTaskProgress(...)
  
  stopSummarization()
  
  agentResult = finalizeAgentTool(agentMessages, taskId, metadata)
  
  // 状态转换优先 -- classifyHandoff/getWorktreeResult 可能 hang, 不能阻塞 TaskOutput
  completeAsyncAgent(agentResult, rootSetAppState)
  
  finalMessage = extractTextContent(agentResult.content)
  
  // handoff 安全审查(仅 TRANSCRIPT_CLASSIFIER feature 开启时)
  if (feature('TRANSCRIPT_CLASSIFIER')):
    handoffWarning = await classifyHandoffIfNeeded(...)
    if (handoffWarning) finalMessage = `${handoffWarning}\n\n${finalMessage}`
  
  worktreeResult = await getWorktreeResult()
  
  enqueueAgentNotification({
    taskId, description, status: 'completed',
    finalMessage, usage: { totalTokens, toolUses, durationMs },
    toolUseId, ...worktreeResult
  })

catch AbortError:
  killAsyncAgent(taskId)
  worktreeResult = await getWorktreeResult()
  partialResult = extractPartialResult(agentMessages)
  enqueueAgentNotification({ status: 'killed', finalMessage: partialResult, ... })

catch error:
  failAsyncAgent(taskId, errMsg)
  worktreeResult = await getWorktreeResult()
  enqueueAgentNotification({ status: 'failed', error: errMsg, ... })

finally:
  clearInvokedSkillsForAgent(agentIdForCleanup)
  clearDumpState(agentIdForCleanup)
```

### 4.6 关键时序约束

`agentToolUtils.ts:599-602` 注释:
> Mark task completed FIRST so TaskOutput(block=true) unblocks immediately. classifyHandoffIfNeeded (API call) and getWorktreeResult (git exec) are notification embellishments that can hang - they must not gate the status transition (gh-20236).

状态转换(`completeAsyncAgent`)必须在 handoff 分类和 worktree 清理**之前**执行, 否则 git hang 或分类器 API 超时会阻塞 `TaskOutput` 的 `block=true` 调用。

## 5. 完成通知机制

### 5.1 通知 XML 格式

`LocalAgentTask.tsx:252-257`:
```xml
<task-notification>
<task-id>{taskId}</task-id>
<tool-use-id>{toolUseId}</tool-use-id>
<output-file>{outputPath}</output-file>
<status>completed|failed|killed</status>
<summary>Agent "{description}" completed</summary>
<result>{finalMessage}</result>
<usage><total_tokens>N</total_tokens><tool_uses>N</tool_uses><duration_ms>N</duration_ms></usage>
<worktree><worktree-path>...</worktree-path><worktree-branch>...</worktree-branch></worktree>
</task-notification>
```

### 5.2 通知入队

`enqueueAgentNotification()` (`LocalAgentTask.tsx:197-262`):

1. **原子去重**: `updateTaskState` 内检查 `task.notified` flag, 已通知则跳过(防 TaskStop 和正常完成重复通知)
2. `abortSpeculation()`: 中止推测性建议(后台任务状态变了, 推测结果可能引用过期输出)
3. 构建消息文本
4. `enqueuePendingNotification({ value: message, mode: 'task-notification' })` 入队

### 5.3 统一命令队列

`messageQueueManager.ts:53-56`:
```typescript
const commandQueue: QueuedCommand[] = []
```

所有命令(用户输入、任务通知、孤儿权限)进同一个队列。优先级 (`messageQueueManager.ts:151-155`):
```
now(0) > next(1) > later(2)
```

`enqueue()` (`messageQueueManager.ts:128`) 默认 `priority: 'next'` -- 用户输入优先。
`enqueuePendingNotification()` (`messageQueueManager.ts:142`) 默认 `priority: 'later'` -- **任务通知永远不饿死用户输入**。

`dequeue()` (`messageQueueManager.ts:167-193`) 取最高优先级命令, 同优先级 FIFO。

### 5.4 父代理消费时机

CC **不在工具回合边界主动 drain**。通知作为一条 `priority: 'later'` 的命令进入队列, 由主循环在**回合之间** dequeue 消费。这意味着:

- 如果父代理正在执行一个长 turn(多步工具调用), 通知会在队列里等到 turn 结束
- 用户的新输入(`priority: 'next'`)会排在通知(`priority: 'later'`)前面

这是与 DAO 的关键差异: DAO 在每个工具轮边界 `drainNotifications()`, CC 在回合间消费。

### 5.5 通知原子性

`notified` flag (`LocalAgentTask.tsx:224-240`) 保证一个任务只发一次通知, 无论:
- 正常完成 + TaskStop 同时触发
- 多个异步路径同时结算

`markAgentsNotified()` (`LocalAgentTask.tsx:322-332`) 用于 `chat:killAgents` 批量杀场景: 标记所有 agent 已通知, 然后发一条聚合消息代替 N 条单独通知。

## 6. 父 -> 子中途通信: SendMessage

### 6.1 语义

CC 的 SendMessage (`SendMessageTool.ts`) 不是 DAO 的 task_send 那种"追加一条指令等下回合消费"。它有三种行为:

1. **运行中任务**: `queuePendingMessage()` 入队, 子代理在下一个工具回合边界通过 `getAgentPendingMessageAttachments()` drain (`attachments.ts:1085-1101`)

2. **已停止任务**: 自动 resume -- `resumeAgentBackground()` 从磁盘转录重建子代理, 把消息作为新的 prompt 注入 (`SendMessageTool.ts:822-844`)

3. **已驱逐任务(不在 AppState)**: 尝试从磁盘 transcript resume (`SendMessageTool.ts:846-872`)

### 6.2 投递机制

`LocalAgentTask.tsx:162-167`:
```typescript
export function queuePendingMessage(taskId, msg, setAppState): void {
  updateTaskState<LocalAgentTaskState>(taskId, setAppState, task => ({
    ...task,
    pendingMessages: [...task.pendingMessages, msg]
  }));
}
```

`LocalAgentTask.tsx:181-192`:
```typescript
export function drainPendingMessages(taskId, getAppState, setAppState): string[] {
  const task = getAppState().tasks[taskId];
  if (!isLocalAgentTask(task) || task.pendingMessages.length === 0) return [];
  const drained = task.pendingMessages;
  updateTaskState(taskId, setAppState, t => ({ ...t, pendingMessages: [] }));
  return drained;
}
```

### 6.3 消费时机

`attachments.ts:916-918`:
```typescript
maybe('agent_pending_messages', async () =>
  getAgentPendingMessageAttachments(toolUseContext),
),
```

`getAgentPendingMessageAttachments` 在 `buildAttachments()` 里调用, 而 `buildAttachments()` 在**每个 API 请求前**执行。所以 SendMessage 消息在子代理的**下一个 API 请求**时被消费, 作为 `queued_command` 类型的 attachment 注入。

注入格式 (`attachments.ts:1095-1100`):
```typescript
return drained.map(msg => ({
  type: 'queued_command' as const,
  prompt: msg,
  origin: { kind: 'coordinator' as const },
  isMeta: true,
}))
```

### 6.4 name -> agentId 路由

`AgentTool.tsx:94` schema 含 `name` 字段:
```typescript
name: z.string().optional().describe('Name for the spawned agent. Makes it addressable via SendMessage({to: name}) while running.'),
```

`AgentTool.tsx:700-712` 注册到 `agentNameRegistry`:
```typescript
if (name) {
  rootSetAppState(prev => {
    const next = new Map(prev.agentNameRegistry);
    next.set(name, asAgentId(asyncAgentId));
    return { ...prev, agentNameRegistry: next };
  });
}
```

`SendMessageTool.ts:802-873` 路由: 先查 `agentNameRegistry`(按 name), 再尝试 `toAgentId(input.to)`(按 raw ID)。找到运行中任务 -> `queuePendingMessage`; 找到已停止任务 -> `resumeAgentBackground`。

## 7. 子 -> 父中途通信

**CC 没有此通道。**

后台子代理不能主动给父代理发中途消息。父代理只能:
1. 等完成通知
2. 主动用 SendMessage 给子代理发消息(单向)
3. 用 TaskOutput(block=true) 阻塞等待子代理完成
4. 用 TaskStop 杀掉子代理

子代理的中间状态只能通过:
- `updateAsyncAgentProgress()` 更新 AppState 里的 progress(工具调用数、token 数、最近活动) -- 这是 UI 可见的, 不是给 LLM 的消息
- `startAgentSummarization()` 定期生成 1-2 句进度摘要 -- 存到 `task.progress.summary`, UI 可见, 不是给 LLM 的消息

## 8. fork 机制

### 8.1 触发条件

`forkSubagent.ts:32-39`:
```typescript
export function isForkSubagentEnabled(): boolean {
  if (feature('FORK_SUBAGENT')) {
    if (isCoordinatorMode()) return false;      // coordinator 模式互斥
    if (getIsNonInteractiveSession()) return false; // 非交互模式不可用
    return true;
  }
  return false;
}
```

开启时(`AgentTool.tsx:557`):
- `forceAsync = true` -- **所有**子代理都走异步路径(不仅 fork), 统一 `<task-notification>` 交互模型
- schema 的 `subagent_type` 变为 optional, 省略时触发 fork

`AgentTool.tsx:438-446`:
```typescript
const isForkPath = isForkSubagentEnabled() && !input.subagent_type && !input.model;
```

fork 与 `model` 互斥(换模型会让前缀缓存失效)。

### 8.2 缓存对齐设计

fork 的核心目标: 子代理的 API 请求与父代理最近的 API 请求**字节级前缀一致**, 命中同一段 prompt cache。

`forkSubagent.ts:60-71` FORK_AGENT 定义:
```typescript
export const FORK_AGENT = {
  agentType: 'fork',
  tools: ['*'],              // 配合 useExactTools: 直接用父工具池
  maxTurns: 200,
  model: 'inherit',          // 继承父模型
  permissionMode: 'bubble',  // 权限提示冒泡到父终端
  source: 'built-in',
  getSystemPrompt: () => '', // 实际用 override.systemPrompt 传父的 rendered prompt
}
```

缓存键五要素 (`forkedAgent.ts:46-56`):
```
system prompt + tools + model + messages(prefix) + thinking config
```

fork 子代理对齐方式:
1. **system prompt**: `override.systemPrompt = toolUseContext.renderedSystemPrompt` -- 传父的已渲染 prompt **字节**, 不重新 getSystemPrompt() (防 GrowthBook 冷热状态漂移致缓存 bust) (`AgentTool.tsx:496-497`, `forkSubagent.ts:54-58`)
2. **tools**: `useExactTools: true` -> `runAgent.ts:500-502` 直接用 `toolUseContext.options.tools`, 跳过 `filterToolsForAgent`
3. **model**: `model: 'inherit'` -> `getAgentModel()` 返回父模型
4. **messages**: `forkContextMessages: toolUseContext.messages` -> `buildForkContextMessages()` 处理后传入
5. **thinking config**: `runAgent.ts:679-682` `useExactTools` 时继承父的 thinkingConfig

### 8.3 buildForkedMessages

`forkSubagent.ts:107-169`:

输入: directive(用户指令) + 父的最后一条 assistant 消息(含 tool_use blocks)

输出: `[fullAssistantMessage, toolResultMessage]`

```
fullAssistantMessage: 父的 assistant 消息原样 clone(保留 thinking/text/tool_use 全部 content blocks)
toolResultMessage:    单条 user 消息, 内容 = [占位 tool_result × N, directive text block]
```

每个 tool_use 对应一个占位 tool_result, 文本统一为 `"Fork started - processing in background"` (`forkSubagent.ts:93`)。所有 fork 子共享这个占位文本, 最大化缓存命中。

**只有最后的 directive text block 不同**, 前面所有字节一致。

### 8.4 buildForkContextMessages

`AgentTool.tsx:630`:
```typescript
forkContextMessages: isForkPath ? toolUseContext.messages : undefined,
```

`runAgent.ts:370-376`:
```typescript
const contextMessages: Message[] = forkContextMessages
  ? filterIncompleteToolCalls(forkContextMessages)
  : [];
```

`runAgent.ts:288-291`:
```typescript
const initialMessages: Message[] = forkContextMessages
  ? [...contextMessages, ...promptMessages]  // fork: 父全部消息 + fork 消息
  : [{ role: 'system', content: agentSystemPrompt }, ...promptMessages]; // 普通: system + prompt
```

fork 子代理拿到的是: **父的完整对话历史**(过滤未配对 tool_use 后) + `buildForkedMessages` 构建的 fork 消息。

### 8.5 buildChildMessage (directive)

`forkSubagent.ts:171-198`:

```xml
<fork-boilerplate>
STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. Your system prompt says "default to forking." IGNORE IT — that's for the parent. You ARE the fork. Do NOT spawn sub-agents; execute directly.
2. Do NOT converse, ask questions, or suggest next steps
3. Do NOT editorialize or add meta-commentary
4. USE your tools directly: Bash, Read, Write, etc.
5. If you modify files, commit your changes before reporting. Include the commit hash in your report.
6. Do NOT emit text between tool calls. Use tools silently, then report once at the end.
7. Stay strictly within your directive's scope. If you discover related systems outside your scope, mention them in one sentence at most - other workers cover those areas.
8. Keep your report under 500 words unless the directive specifies otherwise. Be factual and concise.
9. Your response MUST begin with "Scope:". No preamble, no thinking-out-loud.
10. REPORT structured facts, then stop

Output format (plain text labels, not markdown headers):
  Scope: <echo back your assigned scope in one sentence>
  Result: <the answer or key findings, limited to the scope above>
  Key files: <relevant file paths - include for research tasks>
  Files changed: <list with commit hash - include only if you modified files>
  Issues: <list - include only if there are issues to flag>
</fork-boilerplate>

你的指令: {directive}
```

### 8.6 防递归 fork

`forkSubagent.ts:78-89`:
```typescript
export function isInForkChild(messages: MessageType[]): boolean {
  return messages.some(m => {
    if (m.type !== 'user') return false;
    const content = m.message.content;
    if (!Array.isArray(content)) return false;
    return content.some(
      block => block.type === 'text'
        && block.text.includes(`<${FORK_BOILERPLATE_TAG}>`),
    );
  });
}
```

fork 子保留了 Agent 工具(为缓存对齐), 但检测到消息历史中有 `<fork-boilerplate>` 标签时拒绝再 fork。

### 8.7 fork + worktree 组合

`AgentTool.tsx:598-602`:
```typescript
if (isForkPath && worktreeInfo) {
  promptMessages.push(createUserMessage({
    content: buildWorktreeNotice(getCwd(), worktreeInfo.worktreePath)
  }));
}
```

`forkSubagent.ts:205-210` `buildWorktreeNotice`: 告知子代理继承的上下文路径指向父目录, 需翻译到 worktree; 编辑前重读文件。

## 9. worktree 隔离

### 9.1 创建

`worktree.ts:902-952` `createAgentWorktree(slug)`:

1. **hook 优先**: `hasWorktreeCreateHook()` -> `executeWorktreeCreateHook(slug)` (支持非 git VCS)
2. **git worktree 回退**:
   - `findCanonicalGitRoot()` 找主仓库根(防止从 worktree 内嵌套)
   - `getOrCreateWorktree(gitRoot, slug)`:
     - **fast resume**: 如果 worktree 已存在(读 `.git` 指针文件), 跳过 fetch 直接返回
     - **新建**: fetch origin/default branch -> `git worktree add -B worktree-{slug} {path} {baseBranch}`
   - `performPostCreationSetup()`:
     - 复制 `settings.local.json` 到 worktree 的 `.claude/` 目录
     - 配置 `core.hooksPath` 指向主仓库的 `.husky` 或 `.git/hooks`(解决相对路径问题)
     - 按 `settings.worktree.symlinkDirectories` 符号链接目录(省磁盘)
     - 按 `.worktreeinclude` 复制 gitignored 文件(node_modules 等)
   - sparse-checkout 支持: `settings.worktree.sparsePaths`

### 9.2 清理

`AgentTool.tsx:644-685` `cleanupWorktreeIfNeeded()`:

```
有 headCommit:
  hasWorktreeChanges(worktreePath, headCommit)?
    → true (有未提交改动或新 commit): 保留, 返回 { worktreePath, worktreeBranch }
    → false (无改动): removeAgentWorktree() 删除, 返回 {}
无 headCommit (hook-based):
  始终保留(无法检测 VCS 改动), 返回 { worktreePath }
```

`hasWorktreeChanges()` (`worktree.ts:1144-1173`):
1. `git status --porcelain` -- 有未提交改动 -> true
2. `git rev-list --count {headCommit}..HEAD` -- 有新 commit -> true
3. git 命令失败 -> true (fail-closed, 不误删)

### 9.3 定期清理

`worktree.ts:1125-1136` `cleanupStaleAgentWorktrees()`: 扫描主仓库的 `.claude/worktrees/` 目录, 删除超过 30 天未修改的 worktree。

### 9.4 在 AgentTool 中的使用

`AgentTool.tsx:590-593`:
```typescript
if (effectiveIsolation === 'worktree') {
  const slug = `agent-${earlyAgentId.slice(0, 8)}`;
  worktreeInfo = await createAgentWorktree(slug);
}
```

worktree 路径传给 `runAgent` 的 `worktreePath` 参数, 子代理的 `cwd` 被覆盖到 worktree 路径 (`runAgent.ts:641` `wrapWithCwd`)。

## 10. Agent 恢复 (resume)

### 10.1 触发场景

- SendMessage 给已停止的 agent (`SendMessageTool.ts:822-872`)
- SendMessage 给已从 AppState 驱逐的 agent (从磁盘 transcript 恢复)

### 10.2 resumeAgentBackground

`resumeAgent.ts:42-100+`:

```
1. 读磁盘: getAgentTranscript(agentId) + readAgentMetadata(agentId)
2. 过滤消息:
   - filterUnresolvedToolUses: 去掉未配对 tool_use 的 assistant 消息
   - filterOrphanedThinkingOnlyMessages: 去掉孤儿 thinking-only 消息
   - filterWhitespaceOnlyAssistantMessages: 去掉空白 assistant 消息
3. reconstructForSubagentResume: 重建 contentReplacementState(tool_result 压缩恢复)
4. 判断是否是 fork agent (useExactTools), 读取原 worktreePath
5. registerAsyncAgent: 注册新任务
6. runAsyncAgentLifecycle: 从过滤后的消息继续跑
```

恢复后的 agent 用**已有的转录**作为上下文, 新的 prompt 作为 user 消息追加。不是从零重跑。

## 11. handoff 安全审查

### 11.1 触发条件

`agentToolUtils.ts:389-481` `classifyHandoffIfNeeded`:

```typescript
if (feature('TRANSCRIPT_CLASSIFIER')) {
  if (toolPermissionContext.mode !== 'auto') return null;  // 仅 auto 模式
  // ...
}
```

仅在 `TRANSCRIPT_CLASSIFIER` feature 开启 + `auto` 权限模式时触发。

### 11.2 审查内容

```typescript
const classifierResult = await classifyYoloAction(
  agentMessages,                                    // 子代理完整转录
  {
    role: 'user',
    content: [{
      type: 'text',
      text: "Sub-agent has finished and is handing back control to the main agent. "
          + "Review the sub-agent's work based on the block rules and let the main "
          + "agent know if any file is dangerous (the main agent will see the reason)."
    }],
  },
  tools, toolPermissionContext, abortSignal,
);
```

分类器审查子代理的**整段操作转录**, 判断是否有违规操作(删文件、读写凭据等)。

### 11.3 结果处理

- `shouldBlock = true` + `unavailable = true`: 分类器不可用, 返回 warning: "安全分类器不可用, 请仔细验证"
- `shouldBlock = true` + `unavailable = false`: 返回 `SECURITY WARNING: ... Reason: {reason}`
- `shouldBlock = false`: 返回 null(无 warning)

warning 前置到子代理结果文本: `finalMessage = ${handoffWarning}\n\n${finalMessage}`

### 11.4 调用时机

- **同步路径**: `AgentTool.tsx:1236-1252`, finalize 后立即审查, 直接修改 `agentResult.content`
- **异步路径**: `agentToolUtils.ts:607-620`, `completeAsyncAgent` 之后审查, 修改 `finalMessage` 后入队通知
- **前台转后台路径**: `AgentTool.tsx:961-974`, 后台跑完后审查

三条路径都保证: 子代理结果到达父代理**之前**过一次分类器。

## 12. yoloClassifier 两阶段 XML 分类器

### 12.1 三种模式

`yoloClassifier.ts:696-710`:

| 模式 | 行为 | stage1 max_tokens | stage2 max_tokens |
|------|------|-------------------|-------------------|
| `both` (默认) | stage1 先跑, allow 则返回; block 则升级到 stage2 | 64 | 4096 |
| `fast` | 仅 stage1, verdict 终局 | 256 | - |
| `thinking` | 仅 stage2, 跳过 stage1 | - | 4096 |

### 12.2 stage1 (fast)

`yoloClassifier.ts:769-857`:
- `max_tokens: 64` + `stop_sequences: ['</block>']` -- 强制立即输出 `<block>allow</block>` 或 `<block>block</block>`
- 输出 `false`(allow) -> 立即返回, 不跑 stage2
- 输出 `true`(block) -> 升级到 stage2
- 输出 `null`(不可解析) -> `fast` 模式下 block for safety; `both` 模式下升级到 stage2

### 12.3 stage2 (thinking)

`yoloClassifier.ts:860-940`:
- `max_tokens: 4096` -- 允许 chain-of-thought
- 共享同一 system prompt + user content, 命中 stage1 的缓存前缀
- 输出含 `<thinking>` reasoning + `<block>` verdict + `<reason>` 原因
- 输出 `null`(不可解析) -> block for safety

### 12.4 缓存优化

`yoloClassifier.ts:1097-1106`:
```typescript
// Place cache_control on the action block. In the two-stage classifier,
// stage 2 shares the same transcript+action prefix as stage 1 - the
// breakpoint here gives stage 2 a guaranteed cache hit on the full prefix.
userContentBlocks.push({
  type: 'text' as const,
  text: actionCompact,
  cache_control: cacheControl,
});
```

system prompt 和 user content(transcript + action)在 stage1 和 stage2 之间共享, stage2 命中 stage1 的缓存。

### 12.5 fail-closed

`yoloClassifier.ts:941-995` catch 块:
- AbortError -> `shouldBlock: true, unavailable: true`
- PromptTooLong -> `shouldBlock: true`
- 其他错误 -> `shouldBlock: true, unavailable: stage1Usage === undefined`(stage1 没跑过才标记 unavailable)

分类器不可用时**不**放行, 而是 block + warning。但 handoff 场景下 (`agentToolUtils.ts:464-469`), unavailable 时仍传递结果, 只附加 warning: "分类器不可用, 请仔细验证"。

## 13. 熔断机制 (denialTracking)

### 13.1 状态

`denialTracking.ts:7-10`:
```typescript
export type DenialTrackingState = {
  consecutiveDenials: number;
  totalDenials: number;
}
```

### 13.2 阈值

`denialTracking.ts:12-15`:
```typescript
export const DENIAL_LIMITS = {
  maxConsecutive: 3,
  maxTotal: 20,
} as const;
```

- 连续 3 次拒绝 -> 回退人工
- 总计 20 次拒绝 -> 回退人工

### 13.3 记录与重置

- `recordDenial(state)`: `consecutiveDenials + 1`, `totalDenials + 1`
- `recordSuccess(state)`: `consecutiveDenials = 0`(totalDenials 不重置)
- `shouldFallbackToPrompting(state)`: `consecutiveDenials >= 3 || totalDenials >= 20`

### 13.4 权限引擎集成

`permissions.ts:483-494`: auto 模式下, 分类器 allow -> `recordSuccess()`; 分类器 block -> `recordDenial()`。
`permissions.ts:974-975`: 每次拒绝后更新 `appState.denialTracking`。
`permissions.ts:1004-1012`: 达到阈值 -> 切换到 default 模式 + 通知用户。

### 13.5 circuit breaker

`permissionSetup.ts:713-765`: `tengu_auto_mode_config.disableFastMode` 是 GrowthBook 控制的临时 circuit breaker, 紧急情况下远程关闭 auto 模式的 fast 分类器路径。

## 14. 进度追踪与摘要

### 14.1 ProgressTracker

`LocalAgentTask.tsx:41-49`:
```typescript
export type ProgressTracker = {
  toolUseCount: number;
  latestInputTokens: number;        // API input 是累计的, 取最新值
  cumulativeOutputTokens: number;   // API output 是 per-turn 的, 累加
  recentActivities: ToolActivity[];
};
```

`updateProgressFromMessage()` (`LocalAgentTask.tsx:68-96`): 从 assistant 消息更新 tracker。每个 tool_use 计入 `toolUseCount`, 最多保留 5 个 recent activities。

### 14.2 Agent Summary

`agentToolUtils.ts:543-553`:
```typescript
const onCacheSafeParams = enableSummarization
  ? (params: CacheSafeParams) => {
      const { stop } = startAgentSummarization(
        taskId, asAgentId(taskId), params, rootSetAppState,
      );
      stopSummarization = stop;
    }
  : undefined;
```

`enableSummarization` (`AgentTool.tsx:750`):
```typescript
enableSummarization: isCoordinator || isForkSubagentEnabled() || getSdkAgentProgressSummariesEnabled(),
```

coordinator 模式、fork 模式或 SDK 进度摘要开启时, 后台子代理定期生成 1-2 句进度摘要, 存到 `task.progress.summary`。摘要器复用 `CacheSafeParams` 的前缀缓存(同模型、同 system prompt、同工具池)。

## 15. 模型解析

### 15.1 getAgentModel

`runAgent.ts:254-265`(从 `utils/model/agent.ts` 导入):
```
优先级: toolSpecifiedModel > agentDefinition.model > getDefaultSubagentModel()
```

`getDefaultSubagentModel()` 返回 `'inherit'` -- 默认继承父模型。

### 15.2 alias 防降级

`agentToolUtils.ts`(从 `utils/model/agent.ts`): `aliasMatchesParentTier()` 防降级: parent 用 Opus 时 spawn `model: 'opus'` -> 继承 parent 精确 model string 而非解析别名。

### 15.3 环境变量覆盖

`CLAUDE_CODE_SUBAGENT_MODEL` 环境变量可全局覆盖所有子代理模型。

## 16. AgentTool schema

### 16.1 输入

`AgentTool.tsx:82-125`:

```typescript
baseInputSchema = z.object({
  description: z.string(),          // 3-5 词描述
  prompt: z.string(),               // 子代理任务
  subagent_type: z.string().optional(),  // agent 类型(fork 开启时可省略)
  model: z.enum(['sonnet', 'opus', 'haiku']).optional(),
  run_in_background: z.boolean().optional(),
});

fullInputSchema = baseInputSchema.merge(z.object({
  name: z.string().optional(),           // SendMessage 路由名
  team_name: z.string().optional(),      // 团队名
  mode: permissionModeSchema().optional(), // 权限模式
  isolation: z.enum(['worktree', 'remote']).optional(), // ant 支持 remote
  cwd: z.string().optional(),            // KAIROS: 工作目录覆盖
}));
```

### 16.2 输出

`AgentTool.tsx:141-155`:

```typescript
syncOutputSchema = agentToolResultSchema.extend({
  status: z.literal('completed'),
  prompt: z.string(),
});

asyncOutputSchema = z.object({
  status: z.literal('async_launched'),
  agentId: z.string(),
  description: z.string(),
  prompt: z.string(),
  outputFile: z.string(),
  canReadOutputFile: z.boolean().optional(),
});

outputSchema = z.union([syncOutputSchema, asyncOutputSchema]);
```

### 16.3 输出后处理

`AgentTool.tsx:1328-1370`:

异步结果附带提示文本:
```
Async agent launched successfully.
agentId: {data.agentId} (use SendMessage with to: '{data.agentId}' to continue this agent)
The agent is working in the background. You will be notified automatically when it completes.
```

one-shot built-ins (Explore, Plan) 跳过 SendMessage 提示(`constants.ts:7`, `agentToolUtils.ts:232`)。

## 17. 工具描述生成

### 17.1 getPrompt

`prompt.ts:66-287`: 动态生成 Agent 工具的完整描述, 含:

- agent 列表: `- type: whenToUse (Tools: ...)` (formatAgentLine)
- "When NOT to use" 反指引: 简单搜索用 Glob/Grep 代替
- "Writing the prompt" 指引: 像给新同事 briefing
- 示例: fork / 非 fork 两套

### 17.2 附件注入 (feature flag)

`shouldInjectAgentListInMessages()`: feature flag `tengu_agent_list_attach` 开启时, agent 列表从工具描述移到 `agent_listing_delta` 附件(`<system-reminder>`), 保持工具 schema 静态, 省 10.2% cache_creation tokens。

## 18. 系统提示词注入

### 18.1 getSessionSpecificGuidanceSection

`constants/prompts.ts:352-400`: 条件性注入子代理引导。只显式推 Explore ("广泛搜索用 subagent_type=Explore") 和 verification (需 feature flag `tengu_hive_evidence`)。其余靠工具描述里的 whenToUse 让模型自判。

## 19. 关键设计决策汇总

| 决策 | 理由 | 文件:行 |
|------|------|---------|
| 通知 priority='later' | 用户输入永远不被系统消息饿死 | `messageQueueManager.ts:143` |
| completeAsyncAgent 先于 handoff/worktree | git hang / API 超时不阻塞 TaskOutput | `agentToolUtils.ts:599-602` |
| fork 传 rendered system prompt 字节 | 防 GrowthBook 冷热状态漂移 bust 缓存 | `forkSubagent.ts:54-58` |
| fork 保留 Agent 工具 | 工具 schema 字节一致, 缓存对齐; 防递归靠标签检测 | `forkSubagent.ts:73-77` |
| 占位 tool_result 统一文本 | 所有 fork 子共享, 最大化缓存命中 | `forkSubagent.ts:91-93` |
| ASYNC_AGENT_ALLOWED_TOOLS 白名单 | 后台子代理工具受限, 降低风险 | `constants/tools.ts:55-71` |
| ant 用户允许嵌套 Agent | 内部需要多级代理 | `constants/tools.ts:41` |
| Explore/Plan omitClaudeMd | 省 5-15 Gtok/week | `exploreAgent.ts:79-81` |
| verification criticalSystemReminder 每轮注入 | 防子代理忘记验证身份 | `verificationAgent.ts:150-151` |
| stage1 stop_sequences + 64 token | 强制即时 yes/no, 最小延迟 | `yoloClassifier.ts:781-792` |
| stage2 命中 stage1 缓存 | 共享 system+user prefix, cache_control 在 action block | `yoloClassifier.ts:1097-1106` |
| denialTracking 熔断 | 连续 3 / 总计 20 -> 回退人工 | `denialTracking.ts:12-15` |
| worktree 用 findCanonicalGitRoot | 防止从 worktree 内嵌套 worktree | `worktree.ts:926` |
| worktree -B 而非 -b | 重置孤儿分支, 省 git branch -D 子进程 | `worktree.ts:327` |
| hasWorktreeChanges fail-closed | git 命令失败 -> 保留 worktree, 不误删 | `worktree.ts:1152-1153` |
| 前台转后台重新调 runAgent | 不复用 iterator: 清理 MCP/hooks 后重启 | `AgentTool.tsx:918-940` |
| autoBackground 默认关闭 | 需 CLAUDE_AUTO_BACKGROUND_TASKS 或 GrowthBook 开启 | `AgentTool.tsx:72-77` |
| 后台 agent 独立 AbortController | 不随父 ESC 死, 需显式 kill | `AgentTool.tsx:694-698` |

---

> **文档基于**: `refs/claude-code/src/` 源码快照 (2026-03-31 npm 包 source map 暴露)
> **DAO 对比参考**: `src/agent/` 目录下 DAO 实现
