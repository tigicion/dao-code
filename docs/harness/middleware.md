# 中间件(Middleware)

> 最后核对:2026-07-07,commit `33df233`

## 命名映射说明

dao-code 里没有一个模块直接叫"middleware"。这个词借自 AHE 论文对编码智能体框架的拆解——论文里的 middleware 指"控制上下文、执行与恢复"的横切逻辑。在 dao-code 里,这块职责分散在以下几处,彼此边界清晰但**不共享一个统一入口**:

- **Hooks 系统**(`src/hooks/hooks.ts`)——外部命令级别的事件钩子
- **主循环**(`src/agent/loop.ts`)——每回合的编排骨架
- **压缩**(`src/agent/compact.ts`)——上下文管理
- **反思/记忆抽取**(`unified_reflect.ts` + `reflect_cadence.ts` + `reflect_result.ts` + `reflect_persist.ts`)
- **回合健康检测**(`turn_health.ts`)
- **清理与隔离**(`cleanup.ts`、`worktree.ts`)
- **可观测性旁路**(`src/obs/`)

本文件把这几处放在一起记录,方便以后要不要抽出一个统一"中间件"层时,先看清现状边界。

## 1. Hooks 系统(`src/hooks/hooks.ts`)

- 事件类型是开放字符串,不是枚举。实际接入的有 `PreToolUse`/`PostToolUse`/`SessionStart`/`SessionEnd`/`UserPromptSubmit`(接线见 `src/index.ts:819,823,832,840,1222`)。
- 配置来源:`loadHooks()`(`hooks.ts:54`)读取 Claude Code 兼容格式的 JSON——用户级 `~/.dao/hooks.json`、插件目录下的 `hooks.json`、以及**信任项目**下的 `.dao/hooks.json`(`index.ts:812-818`;未信任目录不加载项目级 hook,这是安全闸门)。
- 触发:`selectHooks()`(`hooks.ts:90`,按事件名 + matcher 正则 + `if` 表达式过滤)和 `runHooks()`(`hooks.ts:123`,当前只执行 `command` 类型,起子进程、按 stdout JSON/exit code 解析出 block/additionalContext/permissionDecision/updatedInput)。
- **实际集成点不在 `loop.ts`**,而在 `src/index.ts` 把 `ctx.preToolHook`/`ctx.postToolHook` 挂到 `ToolContext` 上(`index.ts:819-824`),真正调用点是工具派发层 `src/tools/execute.ts`(约 39/59/72/98/119 行附近)——即在"裁决阶段"和"派发后"各跑一次,而非 loop 主循环本身。
- `integration.test.ts` 只覆盖 `loadHooks+runHooks` 本身,不含 loop/execute 集成,是纯单元验证。

## 2. 主循环(`src/agent/loop.ts` 79-299 行)

`runTurn()` 每个模型回合(`for t<maxTurns`)依次做:

1. 判断是否需要"轮内主动压缩"(`shouldCompact()→compact()`,171-176 行)
2. 消费三类回合边界追加(SendMessage / 异步挑战者 advisory / 后台任务结果,178-197 行)
3. 调模型拿 assistant + tool_calls(199 行)
4. 按 plan/normal 模式派发执行(218-251 行,内部即触发 hooks)
5. 编辑后诊断回灌(254-260 行)
6. 反思层健康评估:`assessTurn()` 判定卡住/漂移,决定是否 fork `deps.reflect(challenger|refocuser)`(274-295 行)

`compact` 是被动注入的依赖(反应式压缩在 `requestAssistant` 里 144-149 行捕获"上下文超限"异常重试);`reflect` 只在这里被"决策"是否调用,真正的模型侧 fork 逻辑在 `index.ts`。

## 3. 压缩(`src/agent/compact.ts`)

- 阈值:`shouldCompact()` 按 `estimateTokens >= maxTokens*0.85`(17-19 行;`index.ts` 实际接线为 `contextTokens() >= CONTEXT_WINDOW*0.85`)。
- 策略:"整段摘要,不留逐字 tail"——保留 `messages[0]`(系统提示)+ 一条覆盖此前全部对话的摘要 + 可选的"当前任务清单"pin(25-68 行)。若已有旧摘要则做增量压缩(旧摘要原样保留、只追加新增摘要,44-50 行)。
- 摘要生成失败时降级为硬截断标记(57-63 行),配合 `index.ts` 里的半开断路器 `summarizeWithBreaker`。

## 4. 反思(两套独立机制共用"反思"这个名字)

### 4a. 回合末统一反思器(`unified_reflect.ts`)

- `reflect()`(117 行)在**回合末(用户轮末)**触发,一次 fork 同时做「记忆抽取」+「进展审视」,产出经 `reflect_result.ts`(`parseReflectResult`,85 行)容错解析,再经 `reflect_persist.ts`(`reflectMemToCand`/`applyCorrections`/`applyConfirmed`)落盘到 memory store(user/project/knowledge 三层,见 [memory.md](memory.md))。
- 调用节奏由 `reflect_cadence.ts` 控制:DeepSeek 官方 key 每轮都跑;Volcengine 方案按 `tickCadence` 自适应放慢/加速(`index.ts:1166-1184`)。
- **重要**:没有独立的 `reflect_pipeline.ts` 文件,`reflect_pipeline.test.ts` 验证的正是"假模型→落盘"这条端到端链路,逻辑分散在 `unified_reflect.ts` + `reflect_persist.ts` + `index.ts` 接线里。
- `distill.ts` 导出的 `distill()` 在生产路径里**已无调用点**(仅测试用),`unified_reflect.ts` 只复用了它的 `isCatalogNoise` 过滤器——即"蒸馏"逻辑已并入统一反思器,不是独立通道。

### 4b. 轮内确定性监控(`loop.ts` 里的 `deps.reflect`)

- `deps.reflect("challenger"|"refocuser")` 是另一条由 `turn_health.ts` 的确定性判定驱动的轻量 fork(`index.ts:1188`,用独立 CHALLENGER/REFOCUSER prompt),只产出一句 advisory,**不碰记忆**,与 4a 完全独立。

## 5. 回合健康检测(`turn_health.ts`)

- 纯函数式的"卡住检测":`assessTurn()`(40 行)跨模型回合累积 `failureStreak`/`repeatedErr`(同错复发用 `errSignature` 归一化签名判定),达阈值 → 建议叫 challenger;长任务模式下每 N 轮 → 建议叫 refocuser。
- 只做判定,不执行 I/O,执行侧在 `loop.ts` 284-294 行。

## 6. 清理与隔离

- `cleanup.ts`:启动时限流到每日一次的 `.dao` 目录卫生清理——清 spill/subagents/sessions 过期产物 + `git worktree prune`(`maybeCleanup`,38 行)。
- `worktree.ts`:给并行子代理创建独立 git worktree + 分支实现隔离(`createWorktree`,14 行),非 git 仓库时优雅回退 `null`。

两者职责边界清晰:一个管"清旧的",一个管"隔离新的"。

## 7. 可观测性旁路(`src/obs/`)

`init.ts`/`backend.ts`/`attrs.ts`/`wrap.ts`,对 Laminar 一类后端做 span 包装:`wrapStreamChat`/`wrapRunTurn`/`wrapToolExec`(`obs/wrap.ts`)分别包一层 LLM 调用、回合、工具执行,记录 token/cache 命中等属性。和上述模块是"旁路观测"关系——不参与控制流决策,只在 loop/execute 外面套一层 span 记录,`isObsOn()` 关闭时零开销直接透传。
