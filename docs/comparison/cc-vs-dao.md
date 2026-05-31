# Claude Code vs DAO CODE 对比分析

> 面向 deepseek-v4-pro agent 实现，重点对比五大特色功能。借鉴点标注了 **CC 的具体实现路径**。

---

## 一、记忆系统

### 1.1 类型体系

| 维度 | CC (Claude Code) | DAO (当前) | 差异 |
|---|---|---|---|
| 类型数 | 4 (user/feedback/project/reference) | 4 (user/semantic/procedural/episodic) | 语义接近但 CC 有 **feedback 类型** |
| 存储格式 | Markdown + YAML frontmatter (MEMORY.md) | Markdown + YAML frontmatter (单文件 *.md) | 同策略 |
| 单文件/多文件 | 支持 private + team 双目录 | 支持 user + project 双目录 | 相似 |
| 范围标签 | `<scope>private/team</scope>` | 隐式（user/project 目录区分） | CC 更细粒度 |

### 1.2 核心差异

| 能力 | CC | DAO | 评价 |
|---|---|---|---|
| **自动提取** | `extractMemories.ts` — 会话中 LLM 提取 | `distill.ts` — 退出时 flash 模型蒸馏 | DAO 更经济（用 flash），但 CC 的时机更灵活 |
| **去重** | 规则匹配 | shingle 相似度（0-1）+ 灰区 flash 裁判 | DAO 更精准（分带处理），CC 更简单 |
| **过期验证** | 记忆漂移警告（"先验证再信"） | 确定性验证（`validate.ts` — sourceHash 对比 + 文件存在性） | **DAO 做得更好**：确定性验证 + changed/stale 标记 |
| **衰减 GC** | 无明确机制 | Ebbinghaus 留存曲线 + uses 次数加成 | **DAO 做得更好**：数学化衰减，保护 user/高重要的不剪 |
| **注入排名** | 无明确机制 | `selectForInjection` — importance × age 衰减排序，cap=150 | **DAO 做得更好** |
| **反馈记忆** | ✅ `feedback` 类型，修复正反馈+负反馈 | ❌ 无 | **CC 独有且关键** |

### 1.3 🔥 借鉴 CC 的点

#### A. 引入 feedback 记忆类型 ✅(2026-06-10 已落地)

**CC 实现**（`src/memdir/memoryTypes.ts` L57-72）：

```typescript
// CC 的 feedback 类型定义
'<type>'
'    <name>feedback</name>'
'    <scope>default to private. Save as team only when the guidance is clearly a project-wide convention</scope>'
'    <description>Guidance the user has given you about how to approach work — both what to avoid and what to keep doing.</description>'
'    <when_to_save>Any time the user corrects your approach OR confirms a non-obvious approach worked. Include *why* so you can judge edge cases later.</when_to_save>'
'    <body_structure>Lead with the rule itself, then a **Why:** line and a **How to apply:** line</body_structure>'
'</type>'
```

**迁移方案**：在 DAO 的 `memory/types.ts` 加 `"feedback"` 类型，distill prompt 中增加对应的 when_to_save 指令。

#### B. 引入"为什么 + 怎么用"记忆体结构 ✅(2026-06-10 已落地,并入 feedback 的 text 结构)

**CC 实现**（`memoryTypes.ts` 中的 `body_structure` 指令）：

```
<body_structure>Lead with the rule itself, then a **Why:** line and a **How to apply:** line.
Knowing *why* lets you judge edge cases instead of blindly following the rule.</body_structure>
```

**CC 的设计理由**：纯规则在边界情况会失效；知道"为什么有这个规则"(如"上次 mock 的测试通过了但 migration 失败了")才能判断当前边界是否适用。

#### C. 记忆漂移警告机制 ✅(2026-06-10 已落地,system prompt 记忆段加行为指令)

**CC 实现**（`memoryTypes.ts` L201-202）：

```typescript
// CC 在 system prompt 中注入的记忆漂移警告
export const MEMORY_DRIFT_CAVEAT =
  '- Memory records can become stale over time. Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct by reading the current state. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory.'
```

**DAO 当前的优点**：DAO 已通过 `validate.ts` 做确定性验证（sourceHash），这个比 CC 更强。但 DAO 缺少 CC 的 **行为指令**——模型不仅要知道"记忆可能过期"，还要知道"该怎么做"。

#### D. 团队记忆的 scope 标签 ❌(暂不做:个人工具,无团队场景)

**CC 实现**（`memoryTypes.ts`）：

```xml
<scope>always private</scope>           <!-- user 类型 -->
<scope>default to private. Save as team only when...</scope>  <!-- feedback 类型 -->
<scope>private or team, but strongly bias toward team</scope> <!-- project 类型 -->
<scope>usually team</scope>             <!-- reference 类型 -->
```

**迁移方案**：DAO 的 Memory 类型加 `scope: "private" | "team"` 字段，distill 时根据类型给指导。

---

## 二、长任务执行

### 2.1 架构对比

| 维度 | CC | DAO |
|---|---|---|
| **后台任务模型** | 完整 Task 系统（7 种类型，状态机） | ProcessManager（简单的进程池） |
| **子代理** | AgentTool → LocalAgentTask（foreground→background 状态机） | `subagent.ts`（同步一次性派发） |
| **消息注入** | `SendMessageTool` + `pendingMessages` 队列 | ❌ 不支持 |
| **进度追踪** | ProgressTracker（工具数/token/最近5活动） | ❌ 无 |
| **会话恢复** | `resumeAgent.ts`（JSONL 转录 + 完整上下文重建） | `Session.log.ts`（JSONL 事件日志 + 恢复） |
| **并发子代理** | Coordinator 模式（并行 workers） | `agent.ts` 并行 scatter-gather ✅ |
| **卡死检测** | 无（CC 没有） | `stuck.ts`（重复工具调用/重复错误 → 提醒 → 止损）✅ |
| **影子 git 检查点** | ❌ 无 | ✅ `checkpoint.ts`（独立 shadow.git，不碰用户 git） |
| **长命令 Stall 检测** | ✅ Stall Watchdog（5s间隔，45s无输出+交互提示模式匹配） | ❌ 无 |
| **孤儿进程清理** | `killShellTasksForAgent()`（代理退出时递归杀子 shell） | ProcessManager.reset()（退出时全局清理） |

### 2.2 🔥 借鉴 CC 的点

#### A. 子代理的 foreground→background 状态机

**CC 实现**（`src/tasks/LocalAgentTask/LocalAgentTask.tsx` L526-613）：

```typescript
// registerAgentForeground: 代理先在前台跑，超过 autoBackgroundMs 后自动转入后台
export function registerAgentForeground({ autoBackgroundMs, ... }): {
  taskId, backgroundSignal, cancelAutoBackground
} {
  // 1. 创建前台任务（isBackgrounded: false）
  const taskState: LocalAgentTaskState = { ...isBackgrounded: false }

  // 2. 创建 backgroundSignal Promise
  //    父代理的 turn 循环 await 这个 signal，后台化时 resolve → 父代理结束当前 turn
  const backgroundSignal = new Promise<void>(resolve => {
    resolveBackgroundSignal = resolve
  })

  // 3. 自动后台化计时器
  const timer = setTimeout(() => {
    setAppState(prev => {
      // 标记 isBackgrounded: true
    })
    // 触发 signal，父代理的 turn 循环退出
    resolver()
  }, autoBackgroundMs)

  return { taskId: agentId, backgroundSignal, cancelAutoBackground }
}
```

**关键设计**：
- `backgroundSignal` Promise 是解耦点：父代理 await 它 → 后台化后父代理结束当前 turn，后续子代理完成通知通过消息队列走下一 turn
- `autoBackgroundMs` 阈值：代理跑够时间才后台化，短任务前台直接完成

#### B. 任务通知的 XML 消息队列

**CC 实现**（`src/tasks/LocalAgentTask/LocalAgentTask.tsx` L197-262）：

```typescript
// CC 的 enqueueAgentNotification: 将子代理完成事件包装为 XML 注入消息队列
export function enqueueAgentNotification({ taskId, description, status, finalMessage, usage }) {
  const message = `<task-notification>
<task-id>${taskId}</task-id>
<status>${status}</status>
<summary>Agent "${description}" completed</summary>
<result>${finalMessage}</result>
<usage><total_tokens>${usage.totalTokens}</total_tokens>...</usage>
</task-notification>`

  enqueuePendingNotification({
    value: message,
    mode: 'task-notification'  // 优先级 'later'，不饿死用户输入
  })
}
```

**CC 的消息队列优先级**（`src/utils/messageQueueManager.ts`）：

```typescript
const PRIORITY_ORDER = { now: 0, next: 1, later: 2 }
// task-notification 默认 'later'
// 用户输入默认 'next'
// 确保后台通知不会抢占用户输入的处理
```

#### C. Batch kill 与孤儿进程清理

**CC 实现**（`src/tasks/LocalShellTask/killShellTasks.ts` L53-76）：

```typescript
// 代理退出时，递归杀死其所有后台 shell 任务
export function killShellTasksForAgent(agentId, getAppState, setAppState) {
  const tasks = getAppState().tasks ?? {}
  for (const [taskId, task] of Object.entries(tasks)) {
    if (isLocalShellTask(task) && task.agentId === agentId && task.status === 'running') {
      killTask(taskId, setAppState)
    }
  }
  // 清除该代理的消息队列条目（防止泄漏）
  dequeueAllMatching(cmd => cmd.agentId === agentId)
}
```

#### D. 前置异步操作并行化

**CC 实现**（`main.tsx` 启动优化）：

```typescript
// main.tsx — 在重模块加载前启动 MDM 和 Keychain 预取
startMdmRawRead()      // 后台读 MDM 配置
startKeychainPrefetch() // 后台读 keychain
// 这些异步操作与后续模块加载并行，减少感知启动延迟
```

---

## 三、Skill 系统

### 3.1 对比

| 维度 | CC | DAO |
|---|---|---|
| **Bundled Skills** | ✅ 17 个内置 skill（verify/commit/debug/simplify...） | ❌ 无（只有 `/help` 等斜杠命令） |
| **Disk-based Skills** | ✅ `.claude/skills/` 目录加载 | ❌ 无 |
| **MCP Skill Builders** | ✅ MCP 服务工具自动暴露为 skill | ❌ 无 MCP |
| **Skill 定义格式** | Markdown frontmatter（tools/allowedTools/model/hooks/...） | — |
| **Skill 提词生成** | `getPromptForCommand(args, ctx)` 动态生成 | — |
| **参数替换** | `$ARGUMENTS` / positional 变量替换 | — |

### 3.2 🔥 借鉴 CC 的点

#### A. Bundled Skill 注册框架

**CC 实现**（`src/skills/bundledSkills.ts` L43-80）：

```typescript
// CC 的 skill 定义接口
export type BundledSkillDefinition = {
  name: string
  description: string
  aliases?: string[]
  whenToUse?: string           // 触发时机描述
  argumentHint?: string        // 参数提示
  allowedTools?: string[]      // 白名单
  model?: string               // 指定模型
  disableModelInvocation?: boolean
  userInvocable?: boolean
  isEnabled?: () => boolean    // feature flag
  context?: 'inline' | 'fork'  // inline=当前上下文, fork=独立子代理
  agent?: string
  files?: Record<string, string>   // 内嵌文件（首次调用时提取到磁盘）
  getPromptForCommand: (args, ctx) => Promise<ContentBlockParam[]>
}

// 注册到内部 registry
export function registerBundledSkill(definition: BundledSkillDefinition) {
  const command: Command = {
    type: 'prompt',
    name: definition.name,
    description: definition.description,
    // ... 包装 getPromptForCommand，支持文件提取 + baseDir 注入
  }
  bundledSkills.push(command)
}
```

#### B. 内置高频 Skill 合集

**CC 内置的 17 个 skill**（`src/skills/bundled/`）：

| Skill | 功能 |
|---|---|
| `verify` | 验证改动（跑测试+typecheck） |
| `commit` | 创建 git commit |
| `debug` | 系统性调试工作流 |
| `simplify` | 代码简化 |
| `stuck` | 卡住时的自救指南 |
| `batch` | 批量操作 |
| `loop` | 循环执行 |
| `remember` | 记忆管理 |
| `skillify` | 将交互转为 skill |

**迁移方案**：在 DAO 中创建 `src/skills/` 目录，先实现 `verify` 和 `commit` 两个最高频的 skill。

#### C. Markdown Frontmatter 定义的 Skill

**CC 的 disk-based skill 加载**（`src/skills/loadSkillsDir.ts`）：

```typescript
// 从 .claude/skills/*.md 扫描 frontmatter，解析为 Command 对象
// frontmatter 字段包括：
// - name, description, whenToUse
// - tools: 允许的工具白名单
// - model: 指定模型
// - argument-hint: 参数提示
// - hooks: PreToolUse/PostToolUse 等钩子
```

---

## 四、资源效率 & 缓存命中

### 4.1 对比

| 维度 | CC | DAO |
|---|---|---|
| **Prompt Cache 策略** | Fork 子代理共享前缀（FORK_PLACEHOLDER_RESULT） | 固定系统前缀 + append-only 铁律 + 测试验证 |
| **缓存杀手防护** | 无显式测试 | ✅ **有专门测试**（`cache_prefix.test.ts` 验证 prefix 逐字节不变） |
| **自动压缩** | `autoCompact.ts` + `microCompact.ts`（多种策略） | `compact.ts`（保留最近 N 轮 + LLM 摘要） |
| **文件缓存** | `FileStateCache`（LRU, 100条目/25MB, 路径归一化） | 无 |
| **超大输出落盘** | 5GB 上限（`MAX_TASK_OUTPUT_BYTES`） | ✅ `tools/spill.ts`（超阈值落 `.codeds/spill/`，上下文只留指针） |
| **Cost 追踪** | `cost-tracker.ts`（按模型定价算费用） | `session.usage`（token 统计 + 缓存命中率） |

### 4.2 🔥 借鉴 CC 的点

#### A. Fork 子代理的 Prompt Cache 共享前缀技巧

**CC 实现**（`src/tools/AgentTool/forkSubagent.ts` L91-169）：

```typescript
// ⭐ 核心技巧：所有 fork 子代理共享完全相同的前缀

const FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'
// 所有 tool_result 块用相同占位符，保证前缀逐字节一致

export function buildForkedMessages(directive, assistantMessage) {
  // 1. 保留完整的父 assistant 消息（含所有 tool_use blocks）
  const fullAssistantMessage = { ...assistantMessage }

  // 2. 为每个 tool_use 构建相同的占位 tool_result
  const toolResultBlocks = toolUseBlocks.map(block => ({
    type: 'tool_result',
    tool_use_id: block.id,
    content: [{ type: 'text', text: FORK_PLACEHOLDER_RESULT }]  // 相同占位符！
  }))

  // 3. 只有最后一条 user message 的 text block 不同（每个子代理的 directive）
  // 结果: [...history, assistant(all_tool_uses), user(placeholder_results..., directive)]
  //        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ 缓存命中
  //                                                                      ^^^^^^^ 仅此不同
  const toolResultMessage = createUserMessage({
    content: [...toolResultBlocks, { type: 'text', text: buildChildMessage(directive) }],
  })

  return [fullAssistantMessage, toolResultMessage]
}
```

**设计原理**：DeepSeek/Anthropic 的 prompt cache 以"前缀"为单位。所有 fork 子代理在 `directive` 之前的所有内容完全一致 → 缓存命中率接近 100%。仅在最后的 user text block（每个子代理不同）发生 cache miss。

**迁移方案**：DAO 的 `agent.ts` 并行 scatter-gather 目前每个子代理独立构建 session，完全无缓存共享。改为 fork 模式后，多个并行子代理共享同一前缀。

#### B. 递归 Fork 防护

**CC 实现**（`forkSubagent.ts` L78-89）：

```typescript
// 通过标记检测防止子代理再 fork
export function isInForkChild(messages: MessageType[]): boolean {
  return messages.some(m => {
    if (m.type !== 'user') return false
    const content = m.message.content
    if (!Array.isArray(content)) return false
    return content.some(block =>
      block.type === 'text' && block.text.includes(`<fork-boilerplate>`)
    )
  })
}
```

#### C. LRU 文件缓存

**CC 实现**（`src/utils/fileStateCache.ts` L1-60）：

```typescript
// 缓存已读文件内容，避免重复读盘
export class FileStateCache {
  private cache: LRUCache<string, FileState>

  constructor(maxEntries = 100, maxSizeBytes = 25 * 1024 * 1024) {
    this.cache = new LRUCache({
      max: maxEntries,
      maxSize: maxSizeBytes,
      sizeCalculation: value => Buffer.byteLength(value.content),
    })
  }

  // ⭐ 关键：路径归一化确保同文件不同写法命中
  get(key: string): FileState | undefined {
    return this.cache.get(normalize(key))  // normalize 处理 /foo/../bar 等
  }
}
```

#### D. 复制缓存给子代理

**CC 实现**（`runAgent.ts` L46-50）：

```typescript
import { cloneFileStateCache } from '../../utils/fileStateCache.js'

// 子代理启动时从父代理克隆文件缓存，避免重复读盘
const fileStateCache = cloneFileStateCache(toolUseContext.fileStateCache)
```

---

## 五、UI 交互友好

### 5.1 对比

| 维度 | CC | DAO |
|---|---|---|
| **TUI 框架** | React + Ink（~140 个组件） | React + Ink（简洁版） |
| **欢迎屏** | 无特殊设计 | ✅ 太极 + 青玉渐变色 + 随机道德经（`banner.ts`） |
| **后台任务状态** | `AgentProgressLine` + `BackgroundHint` + pill 标签 | ❌ 无 |
| **任务面板** | `CoordinatorAgentStatus`（协作者模式下显示所有 worker） | ❌ 无 |
| **审批门** | 复杂的权限系统（permit/deny/always/bubble 等模式） | ✅ 简单审批门（y/a/n） |
| **ESC 打断** | ✅ 批量取消所有子代理 + 清空消息队列 | ✅ AbortController 级联 |
| **Markdown 渲染** | `Markdown.tsx` + `HighlightedCode.tsx` | `tui/markdown.ts` |
| **主题** | `ThemePicker`（多配色方案） | ✅ 自动亮/暗探测（`background.ts`）+ 手动切换 |

### 5.2 🔥 借鉴 CC 的点

#### A. 后台任务 pill 组件

**CC 实现**（`src/tasks/pillLabel.ts` — 任务状态栏文本）：

CC 在 TUI 底部显示类似 "3 background commands running" 的 pill 标签，用户点击可展开任务列表。DAO 当前缺少这个交互。最简单的迁移是：

```typescript
// 简化版 pill 组件伪代码
function TaskPill({ tasks }: { tasks: Task[] }) {
  const running = tasks.filter(t => t.status === 'running')
  if (running.length === 0) return null
  return <Text dimColor>
    [{running.length} background {running.length === 1 ? 'task' : 'tasks'} running]
  </Text>
}
```

#### B. BackgroundHint 组件

**CC 实现**：运行超过阈值的任务出现提示，用户可以：
- 继续等待（保持前台）
- 后台化（转入后台，状态栏显示进度）
- 查看进度

**迁移方案**：在 DAO 的 `runTurn` 中加计时器，超过 `autoBackgroundMs` 后在 events 中触发 hint。

#### C. 虚拟滚动消息列表

**CC 实现**：`VirtualMessageList.tsx` — 长对话时只渲染可见区域的消息。DAO 当前无此优化，长对话可能有性能问题。

---

## 六、DAO 独有的优势（值得保留）

| 功能 | 说明 |
|---|---|
| **确定性记忆验证** | `validate.ts` 的 sourceHash 对比比 CC 的"警告+信任模型"更可靠 |
| **数学化衰减 GC** | Ebbinghaus 留存曲线 + uses 强化信号，比 CC 无 GC 更强 |
| **灰区 flash 裁判** | `adjudicate.ts` — 相似度 0.2~0.9 交给 flash 模型判定是否重复，省钱且精准 |
| **卡死检测** | `stuck.ts` — CC 没有这个能力，对长任务很重要 |
| **影子 git 检查点** | `checkpoint.ts` — `/restore` 一键回退，CC 没有（CC 用 git worktree 隔离） |
| **超大输出落盘** | `spill.ts` — 输出超阈值自动落盘，上下文只放指针 |
| **Prefix Cache 单元测试** | `cache_prefix.test.ts` — 保证了字节稳定，CC 没有对应测试 |
| **rich 欢迎屏** | 太极 + 道德经 + 青玉渐变 = 比 CC 冷冰冰的启动更加"有自己的性格" |
