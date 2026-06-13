# 设计:DAO 子代理与编排对齐 CC(A 派发/注册表 + B 双向通信)

> 目标:把 DAO 的**子代理派发 + 类型注册表(A)**与**模型驱动编排的通信模型(B)**对齐 Claude Code。
> CC 的确定性 Workflow 引擎(C)**不在本设计内**——担心 DeepSeek 在"生成并推理可执行编排脚本"上不够稳,暂缓(见记忆 cc-workflow-engine-deferred)。

## 背景与现状(ground truth)
- 派发工具 `agent`:`task / tasks[]≤20 / background / agent_type / isolate / fork`(`src/tools/agent.ts:13-37`)。
- 类型注册表运行时**已生效**:agent_type 的专属 prompt 追加、`registry.subset(tools)` 工具白名单、`def?.model ?? session.model` 模型覆盖均已应用(`src/index.ts:587-593`);定义来自 `.dao/agents/*.md` + 内置 `explore`/`verify`(`src/agent/agent_defs.ts`、`bundled_agents.ts`),优先级 plugins→user→project。
- 上下文隔离/回传:fresh `Session`、隔离 readFiles、只回传 final message、transcript 落盘(`src/agent/subagent.ts:33-67`)——**已对齐 CC,本设计不动**。
- 通信:`taskManager.send(id,msg)→drainPending(id)` **单向** + 回合边界 `drainNotifications` **轮询**(`src/agent/tasks.ts`),无父↔运行中子代理双向、无完成即唤醒。

## 范围
**纳入**:A1.①model覆盖、A1.②mode覆盖、A2.①内置类型、A2.②排除式tools、A2.③默认general-purpose、A4嵌套放到一层、B双向事件驱动通信。
**Out of scope(留痕,后续可能动)**:`isolation:"remote"`(需远程执行基建,过重);并发数对齐 16 +总量封顶(琐碎,低价值);fork/worktree/background(已对齐);**C 确定性 workflow 引擎**(暂缓,理由见上)。

---

## Part A — 派发与注册表对齐

### A-1 模型选择:结构化前置 + 调用级逃生口(去 prompt 化)
**原则:模型选择是"角色的属性",在 agent_type 里一次定死,而非让模型每次调用现推缓存账。**
- agent_type 携带 `model` 默认(已有字段):`explore`→flash(大量探索本就几乎无前缀缓存可复用,flash 即正确)、`plan`/`verify`→pro、`general-purpose`→跟随主会话 model。
- 新增**调用级** `model?` 入参,仅作逃生口覆盖。优先级:调用级 > agent_type.model > session.model。
- 工具描述**不写"权衡心法"**(不靠 prompt 让模型推理);顶多一行事实陈述"换模型会丢前缀缓存"。
- **硬护栏(代码,非 prompt)**:`fork === true && (有 model 或 mode 覆盖)` → 直接拒绝并说明("fork 跨模型会丢前缀缓存、失去 fork 意义;去掉 model/mode 或改用普通子代理")。不静默降级。
  > 实现采用比"仅当模型不同才拒"更严的版本:fork 下**任何**显式 model/mode 覆盖都拒——杜绝"解析后到底是否真不同"的整类判断 bug,且永不可能 bust fork 缓存。

### A-2 mode 权限模式覆盖
- 新增调用级 `mode?` 入参;子代理当前写死 `mode: session.mode`(`subagent.ts:36`)改为可被覆盖。优先级:调用级 > session.mode。
- DAO 的 mode(`tools_for_mode`)与 CC permission mode 语义不完全同;本设计只做 DAO 自身 mode 的调用级覆盖,不引入 CC 的 mode 枚举。

### A-3 运行时透传(承接 A-1/A-2)
- `runSubagent`(`index.ts:585`)与 `SubagentDeps`(`subagent.ts:10`)签名加 `modelOverride?` / `modeOverride?`,纯参数透传,**不碰会话隔离逻辑**。
- 解析顺序集中在 `runSubagent`:`model = callModel ?? def?.model ?? session.model`;`mode = callMode ?? session.mode`。

### A-4 内置类型集
- `src/agent/bundled_agents.ts` 新增:
  - `general-purpose`:万用 + "我是子代理"纪律(自包含、只回传结论);model 跟随会话;工具全集。
  - `plan`:架构规划,只读 + 设计;model=pro;工具**排除写类**(见 A-5 语法)。
  - 保留 `explore`(flash)/`verify`(pro)。
- **省略 `agent_type` 时默认用 `general-purpose`**(A2.③):`runSubagent` 中 `def=undefined` 时回退到该 def,而非裸 systemPrompt。

### A-5 排除式 tools 白名单
- frontmatter `tools` 支持 `*` 与 `!tool`(排除),如 `tools: "*, !edit_file, !write_file"`。
- `parseAgentDef`(`agent_defs.ts:27`)解析为 `{ include?: string[]; exclude?: string[] }`(纯列举仍兼容旧 `subset` 语义)。
- `registry` 增"全集减排除"能力(现仅 `subset(允许集)`)。
- 边界:解析在 agent_defs,集合运算在 registry。

### A-6 嵌套放到一层
- `agent.ts:39` 阈值 `>=1` → `>=2`:允许 depth2(主→子→子子),depth2 不可再派。
- 超限**不抛异常**:工具返回带"为什么"的拒绝消息("已达嵌套上限 2 层,防递归放大/成本失控,请自行完成或拆小回报"),模型转内联完成。
- **深度感知并发**:depth1 子代理扇出时收紧并发上限(默认 depth2 ≤3 并行,vs depth1 的 10),防 10×10 指数爆。实现为按 `subagentDepth` 取不同 `MAX_PARALLEL`。
- 嵌套真实场景(写入背景):大调查子代理再扇出子探子;子代理充当迷你 coordinator 内部派实现/审查;分治中子任务自身够大。

---

## Part B — 双向事件驱动通信

**现状**单向 + 轮询;**目标**父↔运行中子代理双向 + 完成/消息即唤醒父循环。

### B-1 双向任务信道(`src/agent/tasks.ts`)
- 每个后台任务从"单向 pending 队列"扩为 **父→子 inbox + 子→父 outbox**;outbox 写入时**发事件**(复用已有 `onChange`)。
- 子收父消息已有路径(`drainPending`,`subagent.ts:56`)。

### B-2 子代理→父 工具(新工具 `message_parent`)
- 运行中子代理可主动给父发中途消息/进度/提问,写入该任务 outbox。

### B-3 父→运行中子代理 寻址(扩 `agent` 或新增 `agent_send`)
- 父(模型)可按 id/name 给运行中的具名子代理发消息(写入其 inbox)。

### B-4 事件驱动投递进循环(主循环 / agent loop)
- 后台代理完成或发消息时,在**当前模型回合/工具批次结束的检查点**立即注入并按需自动续跑,而非等人类下一次提交才 drain。建立在已有 `taskManager.onChange`(`index.ts:1342`)上。
- **边界声明**:做到"回合/批次检查点级"事件投递 + 空闲自动续;**真·token 级抢占式打断不做**(过重,留 future)。

---

## 跨切面:缓存安全不变式(关键非功能需求)
DeepSeek 前缀缓存**按模型分桶**且只在前缀 byte 稳定时命中。本设计任何改动**不得引入破坏缓存的 bug**:
1. **前缀不可变**:同一代理的稳定前缀(`messages[0]` system + 早期消息)不因 model/mode 覆盖而改内容或顺序。
2. **fork byte-identical**:fork 必须逐字节复用父前缀才命中(`subagent.ts:39`);fork 跨模型已被 A-1 硬拒。
3. **只追加不插入**:B 的双向消息一律**追加到消息尾部**,绝不 splice 进稳定前缀(SessionStart 哨兵教训:注入进前缀会破坏缓存并累积)。
4. **每模型独立分桶**:flash 子代理建自己的前缀,不与 pro 前缀混用或互相污染。
5. **mode 不回改运行中前缀**:mode 覆盖只在新代理建前缀时生效;不得回改已在跑代理的已缓存前缀。

## 测试策略
- **A 纯函数/schema**:model/mode 解析优先级;fork+跨模型拒绝;排除式集合运算(`*, !x`);depth 阈值与超限消息;深度感知并发取值。
- **A-4 内置 def**:快照测试(general-purpose/plan 的 model/tools/默认回退)。
- **B**:fake taskManager 测双向收发 + 事件触发(outbox 写入触发 `onChange`、inbox 被 drain);端到端——派后台子代理→父发消息→子 `message_parent` 回复→父在检查点收到。
- **缓存安全**:复用 `src/agent/cache_prefix.test.ts` 模式——对 fork 前缀做 byte 相等断言;对 B 注入做"前缀不变、仅尾部增长"断言;model 覆盖时验证不同模型各自独立前缀。

## 文件影响(预估)
| 文件 | 改动 |
|---|---|
| `src/tools/agent.ts` | schema 加 model/mode;fork+跨模型护栏;depth 阈值→2 + 超限消息 + 深度感知并发 |
| `src/agent/subagent.ts` | SubagentDeps 加 modelOverride/modeOverride;mode 可覆盖 |
| `src/index.ts` | runSubagent 透传 model/mode;默认 general-purpose 回退;B-4 事件投递接线 |
| `src/agent/agent_defs.ts` | tools 排除式解析 |
| `src/agent/bundled_agents.ts` | 新增 general-purpose/plan |
| `src/tools/registry.ts` | "全集减排除"能力 |
| `src/agent/tasks.ts` | 双向 inbox/outbox + 事件 |
| 新工具 | `message_parent`(B-2)、父→子寻址(B-3,扩 agent 或新 agent_send) |
| 测试 | 上述各项 + cache_prefix 断言扩展 |
