# 用户画像提取强化 + 记忆合并 pass

日期:2026-06-29 · 状态:待评审 · 作者:审计驱动(slide session 20260629-144349-mxk0)

## 背景与证据

对 slide session 审计发现:**自主反思器对"通用用户画像"系统性失灵**。

- 整场 2 小时,反思器一次都没有把"这是个持续给 2 岁孩子做 iPad 游戏的家长"抽成人物画像。
- 库里那条 `用户画像:为2岁孩子开发 iPad 游戏的家长`(imp 8 / conf 0.85,质量其实很好)是 `{"kind":"wrote","type":"user","ts":1782724178431}` —— `wrote` 事件**只来自 `memory_write` 工具的显式调用**(`ctx.memoryAudit.wrote`);自主反思抽的记忆走 `reflected`/`memAdded`,不发 `wrote`。即:它是**用户提醒后模型手写的**,不是自主抽取的。
- 同一个人的画像还**散在多条 user 记忆**里且重叠:`家长`(imp8)内容已涵盖 `用户偏好 SwiftUI+SpriteKit 做儿童游戏`(imp5),但两者 `slug(title)` 不同,确定性去重撞不上,并存。

### 根因

1. **提取侧**:`REFLECT_TAIL` 把 user 画像和领域记忆一锅烩,没有维度清单可对照,模型默认只记眼前项目事实(滑梯游戏),不会主动**上抽**成跨项目的人物画像。
2. **存储侧**:user 记忆按 `slug(title)` 去重(标题文本),不是按画像**维度**去重 → 同一维度多条并存、越攒越散。
3. **维护侧**:写时 `mergeInto` 是局部贪心(新记忆只并入某一条候选),无任何机制回头对**跨会话累积的重叠**做全局重审。

## 目标

- 让自主反思器**主动、可靠**地抽取通用用户画像(无需人提醒),覆盖明确的画像维度。
- 严格区分 `user_stated`(亲口立的规矩,高置信)与 `inferred`(行为推断,保守置信),并设隐私红线。
- 让 user 画像按**维度**收敛,而非按标题文本——同维度只留一条生效记忆。
- 引入**周期性合并 pass**,在会话启动期清理跨会话累积的重叠/矛盾,且每步可推理、可观测。

## 非目标(YAGNI)

- 不引入独立的 `profile_view.json` 物化视图:dao-code 注入在**会话启动算定一次并冻结进缓存前缀**(`inject.ts`),不是每轮现扫,"读放大"成本已被现有架构摊销。
- 不改领域层(procedural/semantic/episodic)的提取与存储。
- 不引入 SQLite / 二级索引。当前体量(单用户、数十至数百条)文件方案够用。
- 不动注入侧的两层分离(user/feedback 已常驻全文,领域按留存)——这部分已满足需求。

## 设计

三个组件,均不增加 LLM 调用数(提取仍是 REFLECT_TAIL 一次;合并 pass 是低频启动期一次)。

### 组件一:通用画像提取(REFLECT_TAIL 增"画像维度块")

在 `unified_reflect.ts` 的 `REFLECT_TAIL` 记忆段(「二、记忆」)里,把通用画像单列一块,给出**维度清单**与**纪律**,引导模型对照抽取并**上抽**项目事实为人物画像。

**维度清单**(对照抽,别漫无目的;映射到现有 `user`/`feedback` type):
- 沟通偏好:语言、详略、先结论后展开、能否接受直接反对、emoji/寒暄。
- 工作风格:全局优先 vs 细节优先、一次完整方案 vs 小步、重数据 vs 重直觉、容错度(先跑起来 vs 一次做对)。
- 专业背景:职业/角色、领域、资历(决定术语密度)。
- 反复出现的目标/项目:长期在做的事(如"持续给 2 岁孩子做 iPad 游戏")。← 最易混入临时状态,需谨慎。
- 明确硬规矩(user_stated):用户主动立的规矩("别用 emoji""先讨论再动手")。

**纪律**:
1. **跨情境稳定性测试**:换个项目/话题这条还成立吗?不成立(如"现在在调一个 bug")不抽。
2. **上抽**:把项目事实抽象成人物画像——不是记"这个滑梯游戏",是记"这个人持续做低龄儿童游戏、懂其认知边界"。
3. **来源区分**:`user_stated`(亲口立)置信可高;`inferred`(行为推断)单次信号 → conf 0.3–0.4,需多次出现才升。
4. **红线**:性格标签、情绪状态、政治/宗教/健康等敏感信息、无对话佐证的人口统计推测,一律不碰。
5. 冲突优先 `update` 既有画像并在 reason 说明,不直接覆盖。

**输出**:复用现有 `ReflectMem` 结构(title/text/type/importance/confidence/source/mergeInto)。新增约定:`source` 字段对画像类记忆填 `"user_stated"` 或 `"inferred"`(领域记忆仍填代码出处)。`mergeInto` 用于让新画像并入同维度旧画像。

> 实现注:维度清单 + 纪律是 prompt 文本,但配套的去重/合并是代码(组件二、三)——符合"代码优先于 prompt"。

### 组件二:user 画像按维度 path 去重

现状 `dedupKey = slug(title)`(已在上一轮加,见 `store.ts`)。问题:`家长` 与 `swiftui-spritekit` 标题不同 → 不收敛。

写时收敛仍主要靠反思器的 `mergeInto`(语义层),不在 store 里做模糊匹配(保持 store 确定性)。本组件做的是**强化 prompt 让模型对 user 画像更积极地 `mergeInto` 同维度旧条目**——即在维度清单里点明"每个维度只应有一条生效画像,新证据并入而非另起"。

> 即:维度去重的"判断"交反思器(它能语义判断"这两条是同一维度"),"落地"交现有 `mergeInto`→`upsertMemory`(已支持按既有 name 覆盖 + 清残片)。store 不新增模糊逻辑。

### 组件三:启动期合并 pass

**触发**:会话启动,`gcMemories` 之后、`loadAllMemories` 注入算定之前(`index.ts` ~L449)。两道闸:
- `.last-consolidation` 标记(对标 `.last-cleanup`):距上次 < `CONSOLIDATE_EVERY_DAYS`(默认 3)直接跳过。
- 数量门:仅当 user 作用域 live 记忆数 ≥ `CONSOLIDATE_MIN`(默认 12)才跑。
- 仅跑 **user 作用域**(重叠风险最高);模型用 distill 档(便宜)。
- `DAO_NO_MEMORY` / 一次性 `--prompt` / eval 路径不跑。

**做什么**:把 user 作用域全部 live 记忆喂给合并推理 prompt,输出合并计划:
```json
{"groups":[{"canonical":{"title":"…","text":"合成后的规范全文","importance":8,"confidence":0.85,"source":"inferred"},
            "supersede":["旧记忆 name 1","旧记忆 name 2"],"reason":"二者都讲 X,canonical 已涵盖"}]}
```
**落地**:canonical 经 `upsertMemory` 写入(取最高置信、合并 text);`supersede` 列表经 `supersedeMemory` 软删(保留可追溯,GC 宽限期后清)。

**纪律**(prompt 内):
- 不跨 `source` 合并(`user_stated` 与 `inferred` 永不混)。
- 保留最高 confidence;矛盾时偏向 `user_stated` 与更新的 `last_seen`。
- 每个 group 必须给 reason;无可合并 → `groups: []`。
- 保守:拿不准就不合并(漏合并的代价 < 错合并污染全局)。

**可观测**:每次合并落 `consolidation` trace(沿用 memory-trace.jsonl 或新增 `consolidation-trace.jsonl`),记 `{groups, superseded 数, reasons}`;`/audit` 可读。接续上一轮 onTrack note 的"可观测优先"。

## 数据流

```
会话启动
  migrateLegacy → gcMemories(3 scope)
  ├─[新] 合并 pass(gated: user scope, 距上次≥D 天 且 ≥N 条)
  │       loadAll(user) → 合并推理 LLM → upsert canonical + supersede 旧 → trace
  loadAllMemories → validate → selectFullText/Index → 冻结进 system prompt 前缀
回合末
  REFLECT_TAIL(一次)── 领域记忆 + [增]通用画像维度块 → reflectMemToCand → mergeInto/upsert
```

## 测试

- 提取 prompt:`unified_reflect.test.ts` / `reflect_prompts.test.ts` 断言 REFLECT_TAIL 含维度关键词(沟通/工作风格/背景/反复目标/硬规矩)、含 user_stated/inferred、含红线。`reflect_result.ts` 解析 `source: user_stated|inferred`。
- 合并 pass:纯函数 `planConsolidation(parse)` 解析容错(坏 JSON → 空计划);`shouldConsolidate(lastDate, count, today)` 闸门逻辑;落地用现有 supersede/upsert 的集成测试(同维度两条 → 合并为一 + 旧 superseded)。
- gate:`.last-consolidation` 读写 + 跳过路径。
- 回归:全量 vitest 绿;tsc 干净。

## 风险

- **过度合并**:合并 pass 错并两条不同维度 → 污染。缓解:保守纪律 + 不跨 source + supersede 软删(可追溯,可人工恢复)+ reason 可观测复盘。
- **画像误判固化**:把"一次表现"当长期人设。缓解:inferred 单次 → 低置信;GC 的 provisional 门会快剪未被重确认的低置信新条目。
- **启动延迟**:合并 pass 加一次 LLM。缓解:双闸 + 仅 user scope + distill 档;绝大多数启动跳过。

## 取舍记录

- 不上物化视图:dao-code 注入已是"启动算定 + 前缀缓存"摊销,视图是重复造轮子且引入派生态一致性负担。
- 合并放启动而非退出:启动在前缀冻结前、立即改善本会话、复用 GC 槽位;退出不可靠(常被强杀)且不改善当前会话。
