# 子智能体配置(Subagents)

> 最后核对:2026-07-07,commit `33df233`

## 一句话定位

子智能体用 `AgentDef`(名字+专属 prompt+工具白名单+可选模型)定义,内置 4 种类型 + 支持磁盘自定义;每次派发默认是全新隔离 Session、一次性跑到底,同时支持后台并行 + 异步消息回灌主循环。

## 定义方式(`src/agent/agent_defs.ts:8-15`)

```ts
interface AgentDef {
  name, description,
  tools?,          // 工具白名单
  toolsExclude?,   // "*, !x" 语法排除名
  model?,
  prompt,          // 专属 system prompt 正文
}
```

支持从 markdown(frontmatter + 正文)解析:`name`/`description`/`tools`(或 `allowed-tools`)/`model` 写在 frontmatter,正文即 `prompt`(`parseAgentDef`,28-46 行)。`tools` 省略 = 继承全部工具。

## 内置清单(`bundled_agents.ts:5-70`)

| 名字 | 用途 | 工具/模型限制 |
|---|---|---|
| `explore` | 只读彻底探查 | 限定 read/grep/list/search/fetch 等只读工具;默认模型 `deepseek-v4-flash`(省成本) |
| `verify` | 对抗性验证 | 允许 `exec_shell*`;严格要求"判定:通过/不通过/部分"格式 |
| `general-purpose` | 通用兜底 | 不设 model(跟随主会话)、不设 tools(继承全部);`agent_type` 省略时的默认值(`tools/agent.ts:848`) |
| `plan` | 架构规划 | `toolsExclude` 排除写/执行类工具,不设 model |

## 自定义子代理

`loadAgentDefs(projectDir, userDir, pluginDirs)`(`agent_defs.ts:66-74`)从项目 `.dao/agents/*.md`、用户 `~/.dao/agents/*.md`、插件目录加载,同名时项目 > 用户 > 插件,且磁盘定义可覆盖同名内置(`bundled_agents.ts:3`)。

## 运行模型(`subagent.ts`)

`runSubagent`(33-68 行)每次是**全新隔离 Session**(独立 `new Session(systemPrompt, model)`),默认不带主对话历史,只塞一条 user 任务;唯一例外是 `forkMessages`(fork 模式,复用父会话已缓存前缀)。子代理有独立 `readFiles`/`readMeta`,不污染主代理"已读"护栏。

**防递归**:`subagentDepth = ctx.subagentDepth+1`(44 行),`tools/agent.ts:64` 硬限制 `subagentDepth>=2` 时拒绝再派发(最多两层嵌套);且 `depth>=1` 时并行度从 10 收紧到 3(`agent.ts:126-127`),防指数爆炸。

子代理跑在 `background:true` 模式(不重试 529)、`maxTurns:200` 硬上限,完成后转录写入 `.dao/subagents/*.jsonl`(`index.ts:873-880`)。

## `src/tools/agent.ts`(派发入口)

`agent` 工具入参:

- `task`/`tasks[]` —— 单个或最多 20 个并行任务
- `background` —— 是否显式转后台
- `agent_type` —— 选用哪个 `AgentDef`
- `isolate` —— git worktree 隔离改文件(见 [middleware.md](middleware.md) 的 `worktree.ts`)
- `fork` —— 继承父完整上下文、复用缓存前缀
- `model`/`mode` —— 调用级覆盖,与 `fork` 互斥

默认一次性派发(`runOne` 跑到底返回最终文本);单任务超 60s(`DAO_AUTO_BACKGROUND_MS`)自动转后台(110-120 行);显式 `background:true` 则立即返回 task id,经通知队列异步回灌。并行任务用 worker 池限流(126-141 行)。

## 父子通信:`task_send.ts` / `message_parent.ts` / `tasks.ts`

`tasks.ts` 的 `TaskManager` 是后台任务/通知的核心状态机(`launch`/`adopt`/`send`/`emitFromTask`/`drainPending`/`drainNotifications`)。

- `task_send`(**父→子**):父代理调用 `task_send(id, message)` 追加指令,子代理在下一个工具回合边界通过 `drainPending` 消费(`subagent.ts:56`)。
- `message_parent`(**子→父**):仅后台子代理可用,调用后走 `taskManager.emitFromTask`,以 `<task-message>` 形式进通知队列,父代理空闲时收到。
- 子代理正常完成结果以 `<task-notification>` XML(`tasks.ts:40-52`)形式回灌主循环,主循环在 `index.ts:1079/1765` 处 `drainNotifications()` 消费。

## 权限/审批模型

子代理与主代理**共用同一个 `ApprovalGate`/`PermissionGate` 实例**(`index.ts:866`),不是独立沙箱;`mode` 默认继承主会话 `session.mode`(`index.ts:853: subMode = mode ?? session.mode`),可按调用覆盖为 `plan`。已批准的操作(alwaysApproved 存储)、plan 只读限制对子代理同样生效,工具集只是通过 `tools`/`toolsExclude` 白名单在注册表层面裁剪,并非另一套审批策略。

## 后台并行 + 异步回灌

已支持:`background`/`adoptBackground` 让子代理脱离主循环阻塞跑,`TaskManager` 维护运行列表(`tasks.ts:162-164`),完成/失败经 `notifications` 队列以 `<task-notification>` 注入,主循环(`index.ts:1079`、REPL 层 `1798`)在回合边界 `drainNotifications()` 拉取并喂给模型,配合 `onChange` 回调驱动 UI 刷新(`tasks.ts:172-174`)——即"异步任务 + 消息队列"模型已经落地。同时最多后台/并行数受 `DAO_MAX_PARALLEL_AGENTS` 限流(默认 10,`depth>=1` 时 3)。
