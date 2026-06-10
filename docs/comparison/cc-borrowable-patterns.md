# Claude Code 可借鉴的代码模式和具体实现

> 以下是从 CC 源码中提取的可直接参考的实现模式，按五大特色功能组织。
> 文件路径均为 `src/` 下的相对路径。

---

## 一、记忆系统借鉴

### 1.1 引入 Feedback 记忆类型

**目标**：DAO 只有 user/semantic/procedural/episodic 四种类型，缺少关键的用户反馈记忆。

**CC 参考文件**：`memdir/memoryTypes.ts`

**具体改动**：

1. 在 `src/memory/types.ts` 加类型：
```typescript
export type MemoryType = "user" | "semantic" | "procedural" | "episodic" | "feedback";
// 新增 ↑
```

2. 在 `src/memory/distill.ts` 的 system prompt 中加：
```
- feedback 类型：用户的纠正与肯定。格式：规则本身 + **Why:** 原因 + **How to apply:** 适用时机。
  记录失败也记录成功（如果只记录纠正，你会避开错误但也漂离已验证的好方法）。
  纠正易察觉（"别这样做"），肯定更安静——留意它们。
```

3. 修改 `distill.ts` 的 importance 筛选逻辑，feedback 类型降低门限：
```typescript
// CC 的逻辑：反馈记忆即使 importance 较低也值得保留
const MIN_IMPORTANCE = it.type === 'feedback' ? 3 : 4;
if (importance < MIN_IMPORTANCE) continue;
```

### 1.2 引入 "Why + How to apply" 体结构

**目标**：让记忆不仅是事实陈述，还包含判断力。

**CC 参考**：`memoryTypes.ts` 中的 `<body_structure>` 指令：

```
<body_structure>
以规则本身开头，接着一行 **Why:**（原因——通常是过去事故或强烈偏好），再一行 **How to apply:**（何时/何处适用此规则）。
知道 *为什么* 让你在边界情况下判断，而不是盲从规则。
</body_structure>
```

**改动**：在 `distill.ts` 的 system prompt 的 JSON schema 描述中，为 `text` 字段加这个格式要求。

### 1.3 引入明确"不该记什么"的排除清单

**目标**：防止记忆膨胀，明确哪些可推导信息不应记录。

**CC 参考**：`memoryTypes.ts` 的 `WHAT_NOT_TO_SAVE_SECTION`：

```
## What NOT to save in memory
- 代码模式、约定、架构、文件路径——可通过读取当前代码推导
- Git 历史——git log/blame 是权威来源
- 调试解决方案——修复已在代码中；commit message 有上下文
- 已在 CLAUDE.md 中记载的任何内容
- 临时任务细节：进行中的工作、临时状态、当前对话上下文

即使有用户明确要求，也适用此排除清单。
```

**改动**：在 `distill.ts` 的 system prompt 末尾追加此清单。

---

## 二、长任务执行借鉴

### 2.1 foreground→background 状态机

**目标**：让代理支持"前台跑 → 超过阈值 → 自动后台化 → 完成通知"流程。

**CC 参考文件**：`tasks/LocalAgentTask/LocalAgentTask.tsx`（`registerAgentForeground`、`backgroundAgentTask` 函数）

**具体实现**：

```typescript
// ===== src/agent/background.ts (新文件) =====

// Promise resolver 映射：taskId → 触发后台化的函数
const bgResolvers = new Map<string, () => void>()

export interface BackgroundableTask {
  taskId: string
  /** 后台化时 resolve，打断父代理的 turn 循环 */
  backgroundSignal: Promise<void>
  /** 取消自动后台化计时器 */
  cancelAutoBackground: () => void
}

export function registerForegroundTask(args: {
  taskId: string
  description: string
  autoBackgroundMs?: number  // 默认 30000ms
}): BackgroundableTask {
  let resolve: () => void
  const backgroundSignal = new Promise<void>(r => { resolve = r })
  bgResolvers.set(args.taskId, resolve!)

  let cancel: () => void = () => {}
  const ms = args.autoBackgroundMs ?? 30_000
  if (ms > 0) {
    const timer = setTimeout(() => {
      resolve!()
      bgResolvers.delete(args.taskId)
    }, ms)
    cancel = () => clearTimeout(timer)
  }

  return { taskId: args.taskId, backgroundSignal, cancelAutoBackground: cancel }
}

export function backgroundTask(taskId: string): boolean {
  const resolver = bgResolvers.get(taskId)
  if (!resolver) return false
  resolver()
  bgResolvers.delete(taskId)
  return true
}
```

**使用方式**（在 `runTurn` 或工具 handler 中）：

```typescript
// 代理启动时
const { backgroundSignal, cancelAutoBackground } = registerForegroundTask({
  taskId: agentId,
  description: "Fix auth bug",
  autoBackgroundMs: 60_000,  // 60秒后自动后台化
})

// 主循环中
for (let t = 0; t < maxTurns; t++) {
  // ... 工具调用 ...
  const raced = await Promise.race([
    executeToolCalls(...),   // 正常执行
    backgroundSignal.then(() => ({ __backgrounded: true })),  // 被后台化
  ])
  if (raced.__backgrounded) {
    // 标记任务为后台状态，结束当前 turn
    // 后续完成通知走消息队列
    return
  }
}
```

### 2.2 子代理退出时清理孤儿 shell

**目标**：子代理启动的 bash 进程不因代理退出而变成孤儿。

**CC 参考文件**：`tasks/LocalShellTask/killShellTasks.ts`（`killShellTasksForAgent`）

**DAO 迁移**：在 `process_manager.ts` 或 `exec_shell.ts` 中给每个进程打 `agentId` 标签：

```typescript
// 当前 DAO 的 ProcessManager.start() 只需加一个字段：
start(command: string, cwd: string, agentId?: string): string {
  const id = `proc-${++this.counter}`
  // ... 现有逻辑 ...
  proc.agentId = agentId  // 新增
}

// 代理退出时：
killForAgent(agentId: string): void {
  for (const [id, proc] of this.procs) {
    if (proc.agentId === agentId && proc.status === 'running') {
      killTree(proc.child, 'SIGTERM')
    }
  }
}
```

### 2.3 Shell 命令的 Stall Watchdog

**目标**：后台命令卡在交互式提示（如 `(y/n)`、`Continue?`）时主动通知模型。

**CC 参考文件**：`tasks/LocalShellTask/LocalShellTask.tsx`（`startStallWatchdog`、`looksLikePrompt`）

**具体实现**：

```typescript
// ===== 新增 stall watchdog =====
const PROMPT_PATTERNS = [
  /\(y\/n\)/i, /\[y\/n\]/i, /\(yes\/no\)/i,
  /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
  /Press (any key|Enter)/i, /Continue\?/i, /Overwrite\?/i,
]

function looksLikePrompt(tail: string): boolean {
  const lastLine = tail.trimEnd().split('\n').pop() ?? ''
  return PROMPT_PATTERNS.some(p => p.test(lastLine))
}

function startStallWatchdog(
  taskId: string, command: string, onStall: () => void
): () => void {
  let lastSize = 0, lastGrowth = Date.now(), cancelled = false
  const timer = setInterval(() => {
    const currentSize = getOutputSize(taskId)  // 获取输出文件大小
    if (currentSize > lastSize) {
      lastSize = currentSize; lastGrowth = Date.now(); return
    }
    if (Date.now() - lastGrowth < 45_000) return  // 45秒阈值
    const tail = getOutputTail(taskId, 1024)
    if (!looksLikePrompt(tail)) {
      lastGrowth = Date.now()  // 不是 prompt 就重置，可能是慢命令
      return
    }
    cancelled = true; clearInterval(timer)
    onStall()  // 触发通知
  }, 5_000)
  return () => { cancelled = true; clearInterval(timer) }
}
```

### 2.4 消息队列优先级解耦

**目标**：子代理完成通知不应阻塞用户输入。

**CC 参考文件**：`utils/messageQueueManager.ts`

**具体实现**（DAO 当前没有消息队列，可加）：

```typescript
// ===== src/utils/messageQueue.ts (新文件) =====
type Priority = 'now' | 'next' | 'later'

interface Queued {
  value: string
  mode: 'user-input' | 'task-notification'
  priority: Priority
}

const queue: Queued[] = []
const PRIORITY_ORDER = { now: 0, next: 1, later: 2 }

export function enqueue(item: Queued): void {
  queue.push(item)
}

export function dequeue(): Queued | undefined {
  if (queue.length === 0) return undefined
  // 找最高优先级的第一个
  let bestIdx = 0, bestP = 999
  for (let i = 0; i < queue.length; i++) {
    const p = PRIORITY_ORDER[queue[i]!.priority]
    if (p < bestP) { bestP = p; bestIdx = i }
  }
  return queue.splice(bestIdx, 1)[0]
}
```

---

## 三、Skill 系统借鉴

### 3.1 最小可行 Bundled Skill 框架

**目标**：先支持 2-3 个内置 skill（verify、commit）作为 MVP。

**CC 参考文件**：`skills/bundledSkills.ts`、`skills/bundled/verify.ts`

**具体实现**：

```typescript
// ===== src/skills/registry.ts (新文件) =====
import type { ChatMessage } from '../client/types.js'

export interface Skill {
  name: string
  description: string
  whenToUse: string
  allowedTools?: string[]  // undefined = all
  getPrompt: (args: string, ctx: { cwd: string }) => ChatMessage[]
}

const skills = new Map<string, Skill>()

export function registerSkill(skill: Skill): void {
  skills.set(skill.name, skill)
}

export function getSkill(name: string): Skill | undefined {
  return skills.get(name)
}

export function listSkills(): Skill[] {
  return [...skills.values()]
}
```

**verify skill 示例**：

```typescript
// ===== src/skills/bundled/verify.ts =====
import { registerSkill } from '../registry.js'

registerSkill({
  name: 'verify',
  description: '验证改动：跑测试、typecheck、确认通过',
  whenToUse: '改动完成后、提交前',
  allowedTools: ['exec_shell', 'read_file', 'grep_files'],
  getPrompt(args, ctx) {
    return [{
      role: 'system',
      content: `你是一个验证代理。你的唯一职责是验证改动是否真的有效。

## 规则
1. 运行相关测试（如果检测到 test 文件）
2. 运行 typecheck（如果检测到 TypeScript 项目）
3. 绝不修改任何文件
4. 如果测试失败，报告具体哪个测试失败和错误信息
5. 不要草率宣布"通过"——看实际输出

${args ? `额外指示: ${args}` : ''}`
    }]
  },
})
```

### 3.2 从 Markdown 文件加载 Skill

**目标**：支持用户把 skill 写成 `.md` 文件放到 `.dao/skills/`。

**CC 参考文件**：`skills/loadSkillsDir.ts`（`getSkillsPath`、`loadMarkdownFilesForSubdir`）

**简化版实现**：

```typescript
// ===== src/skills/disk_loader.ts =====
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Skill } from './registry.js'

// 解析 YAML-like frontmatter（三段式 --- ... --- ... ---）
function parseFrontmatter(raw: string): { meta: Record<string, string>, body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { meta: {}, body: raw }
  const meta: Record<string, string> = {}
  for (const line of match[1]!.split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)/)
    if (kv) meta[kv[1]!] = kv[2]!
  }
  return { meta, body: match[2]! }
}

export function loadSkillsFromDir(dir: string): Skill[] {
  if (!existsSync(dir)) return []
  const files = readdirSync(dir).filter(f => f.endsWith('.md'))
  return files.map(f => {
    const raw = readFileSync(join(dir, f), 'utf8')
    const { meta, body } = parseFrontmatter(raw)
    const name = meta.name || f.replace('.md', '')
    return {
      name,
      description: meta.description || '',
      whenToUse: meta['when-to-use'] || '',
      allowedTools: meta.tools?.split(',').map(s => s.trim()),
      getPrompt: (args: string, ctx: { cwd: string }) => [{
        role: 'system',
        content: `${body}\n\n${args ? `参数: ${args}` : ''}`
      }],
    }
  })
}
```

---

## 四、缓存效率借鉴

### 4.1 Fork 子代理的前缀共享

**目标**：多个并行子代理共享同一 prompt cache 前缀。

**CC 参考文件**：`tools/AgentTool/forkSubagent.ts`（`buildForkedMessages`、`buildChildMessage`）

**具体实现**：

```typescript
// ===== src/agent/fork.ts (新文件) =====

/** 所有 fork 子代理用相同的占位符 */
const FORK_PLACEHOLDER = 'Fork started — processing in background'
const FORK_TAG = 'fork-boilerplate'

/**
 * 为 fork 子代理构建消息。
 * 
 * 所有子代理的前缀（到 directive 之前）逐字节相同 → prompt cache 共享。
 * 仅最后的 user text block（directive）不同。
 */
export function buildForkMessages(
  directive: string,
  parentMessages: ChatMessage[],
  lastAssistantToolCalls: ToolCall[],
): ChatMessage[] {
  // 1. 克隆 parents 的 assistant 消息（含所有 tool_use blocks）
  const assistant = parentMessages[parentMessages.length - 1]
  
  // 2. 构建 tool_result 块——全部用相同占位符
  const toolResults = lastAssistantToolCalls.map(tc => ({
    role: 'tool' as const,
    tool_call_id: tc.id,
    content: FORK_PLACEHOLDER,
  }))

  // 3. 每个子代理不同的只有这个 directive
  const directiveMsg: ChatMessage = {
    role: 'user',
    content: `<${FORK_TAG}>
你是一个 fork 子代理。你不是主代理。直接执行以下任务：
${directive}
规则：不聊天、不提问、不改超出 scope 的文件、完成后简短汇报。
汇报格式——Scope: 一句话 | Result: 关键发现 | Files changed: 列表+commit hash
</${FORK_TAG}>`,
  }

  return [assistant, ...toolResults, directiveMsg]
}
```

### 4.2 路径归一化文件缓存

**目标**：避免同一文件不同路径写法导致缓存 miss。

**CC 参考文件**：`utils/fileStateCache.ts`

**具体实现**：

```typescript
// ===== src/tools/file_cache.ts (新文件) =====
import { normalize } from 'node:path'

interface CacheEntry {
  content: string
  mtime: number  // 文件修改时间
}

const cache = new Map<string, CacheEntry>()
const MAX_ENTRIES = 200
const MAX_TOTAL_BYTES = 25 * 1024 * 1024  // 25MB
let totalBytes = 0

// LRU 队列
const accessOrder: string[] = []

function evictIfNeeded(): void {
  while (cache.size > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) {
    const oldest = accessOrder.shift()
    if (!oldest) break
    const entry = cache.get(oldest)
    if (entry) totalBytes -= Buffer.byteLength(entry.content)
    cache.delete(oldest)
  }
}

export function getFile(key: string): string | undefined {
  const nk = normalize(key)
  const entry = cache.get(nk)
  if (entry) {
    // LRU: 移到队尾
    accessOrder.splice(accessOrder.indexOf(nk), 1)
    accessOrder.push(nk)
    return entry.content
  }
  return undefined
}

export function setFile(key: string, content: string, mtime = Date.now()): void {
  const nk = normalize(key)
  if (cache.has(nk)) {
    totalBytes -= Buffer.byteLength(cache.get(nk)!.content)
  }
  cache.set(nk, { content, mtime })
  totalBytes += Buffer.byteLength(content)
  accessOrder.push(nk)
  evictIfNeeded()
}
```

### 4.3 Prefix Cache 回归测试

**目标**：确保 tool 定义序列化稳定、系统 prefix 逐字节不变。

**CC 没有，但 DAO 已有**：`src/agent/cache_prefix.test.ts`

DAO 已经走在前面——保留了并扩展这个测试：

```typescript
// 当前 DAO 的 cache_prefix.test.ts 测试了：
// 1. runTurn 仅追加，已有前缀逐字节不变
// 2. system message 永不被修改
// 3. tool 定义序列化逐字节稳定

// 应追加的测试 case:
// 4. memory injection 不改变 non-memory 部分的前缀
// 5. 自动 compact 不改变 system message
```

---

## 五、UI 交互借鉴

### 5.1 后台任务状态 Pill

**目标**：TUI 底部显示后台任务数量。

**CC 参考文件**：`tasks/pillLabel.ts`、`components/TaskListV2.tsx`

**具体实现**（Ink 组件）：

```tsx
// ===== src/tui/components/TaskPill.tsx (新文件) =====
import { Text } from 'ink'
import type { BackgroundableTask } from '../../agent/background.js'

export function TaskPill({ tasks }: { tasks: BackgroundableTask[] }) {
  const running = tasks.filter(t => t.status === 'running')
  if (running.length === 0) return null
  return (
    <Text dimColor>
      [{running.length} 个后台任务运行中]
    </Text>
  )
}
```

### 5.2 耗时操作的进度提示

**目标**：长时间运行的操作给用户进度反馈。

**CC 参考**：`tasks/LocalAgentTask/LocalAgentTask.tsx` 的 `ProgressTracker`

**简化版**：

```typescript
// ===== src/agent/progress.ts (新文件) =====
export interface Progress {
  toolUses: number
  tokensUsed: number
  lastActivity: string  // 如 "Reading src/foo.ts"
}

export class ProgressTracker {
  toolUses = 0
  tokensUsed = 0
  recent: string[] = []

  record(toolName: string, tokens: number): void {
    this.toolUses++
    this.tokensUsed += tokens
    this.recent.push(toolName)
    if (this.recent.length > 5) this.recent.shift()
  }

  snapshot(): Progress {
    return {
      toolUses: this.toolUses,
      tokensUsed: this.tokensUsed,
      lastActivity: this.recent[this.recent.length - 1] || 'idle',
    }
  }
}
```

---

## 六、DAO 保留 & 强化的独特优势

以下功能 DAO 当前已经比 CC 好或 CC 根本没有，**不应在借鉴中被盖掉**：

| DAO 独有功能 | 文件 | 说明 |
|---|---|---|
| 确定性记忆验证 | `memory/validate.ts` | sourceHash 对比，比 CC 的"信任+警告"强 |
| Ebbinghaus GC | `memory/gc.ts` | 数学化衰减，CC 无 |
| 灰区 flash 裁判 | `memory/adjudicate.ts` | 省钱去重，CC 无 |
| 卡死检测 | `agent/stuck.ts` | CC 无，长任务关键 |
| 影子 git 检查点 | `session/checkpoint.ts` | `/restore` 一键回退，CC 用 worktree |
| 超大输出落盘 | `tools/spill.ts` | CC 有但实现不同 |
| Prefix cache 回归测试 | `agent/cache_prefix.test.ts` | CC 无，工程级保障 |
| 太极欢迎屏 | `tui/banner.ts` | 品牌识别度 |

---

## 七、实施优先级建议

按投入产出比排列：

| 优先级 | 借鉴项 | 工作量 | 收益 |
|---|---|---|---|
| P0 | Fork 子代理前缀共享 | 中 | 极高（子代理缓存命中率从 0% → ~98%） |
| P0 | Feedback 记忆类型 | 小 | 高（用户体验跳跃式提升） |
| P1 | foreground→background 状态机 | 大 | 高（长任务核心能力） |
| P1 | "Why + How to apply" 记忆体 | 小 | 中 |
| P1 | Bundled Skill（verify + commit） | 中 | 高（开箱即用） |
| P1 | 子代理孤儿进程清理 | 小 | 中 |
| P2 | Shell Stall Watchdog | 中 | 中 |
| P2 | 磁盘 Skill 加载 | 中 | 中 |
| P2 | LRU 文件缓存 | 小 | 低 |
| P3 | 消息队列优先级 | 中 | 低（当前 UI 已够用） |
| P3 | 虚拟滚动 | 大 | 低（长对话才触发） |
