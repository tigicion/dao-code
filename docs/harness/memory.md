# 长期记忆(Memory)

> 最后核对:2026-07-07,commit `33df233`

## 一句话定位

三层文件级记忆(project/user/knowledge),启动时一次性确定性注入(零模型调用),写入靠回合末统一反思器 + 会话启动后台批量去重两套互补机制,`validate.ts`/`gc.ts` 全程确定性无 LLM。

> 本文件已核对与 `docs/architecture/memory.md`(历史设计文档)的差异,见下方各节标注。总体判断:历史文档的大方向与当前代码一致,但**写入路径的具体承载模块已迁移**,且历史文档"数据模型"一节的 `status` 字段描述已过时,与其自己"落地状态"一节自相矛盾。

## 数据单元格式(`src/memory/types.ts:4-21`, `frontmatter.ts`)

字段:`name`/`title?`/`text`/`type`/`importance`/`confidence?`/`created`/`lastUsed`/`source?`/`sourceHash?`/`uses`/`status`/`supersededBy?`/`validUntil?`/`locked?`/`origin?`。`type` 为 `user|feedback|semantic|procedural|episodic`。

**⚠️ 与历史文档的关键差异**:`docs/architecture/memory.md` 声称 `status` 已扩展为 `active|provisional|confirmed|superseded`,但代码里 `status` 只有 `"active" | "superseded"` 两个值(`types.ts:16`)。所谓 provisional/confirmed 并非落盘字段,而是 `gc.ts` 里用 `uses===0`(provisional)/`uses≥1`(confirmed)动态推算出来的(`gc.ts:39-49`)。

## 存储(`store.ts`)——三层同一套代码路径

三层目录,全部走同一套函数(`readDir`/`loadAllMemories`/`writeMemory`/`upsertMemory`):

- `<workspace>/.dao/memory`(project)
- `~/.dao/memory`(user)
- `~/.dao/knowledge`(procedural 跨项目知识库)

挂载点见 `src/index.ts:460-463`。分层由 `type` 决定,**与 confidence 无关**:`routeScope`(`store.ts:10-14`):`procedural→knowledge`、`user/feedback→user`、其余(`semantic/episodic`)→`project`。

每条记忆一个独立 `.md` 文件(frontmatter+正文),去重键是 `slug(title)` 或退化 `name`(`store.ts:65-67`),`upsertMemory` 命中即覆盖更新且 `uses+1`(85-107 行)。knowledge 层额外按 `origin`(学到时所在项目 id)过滤注入,防止跨项目泄漏(28-36 行,`keepKnowledgeForProject`)。

## 注入(`inject.ts`)——启动一次性,零模型调用

会话启动时一次性算定、整会话固定,**无检索/无 embedding**(`src/index.ts:502-522`):

1. 逐条 `validateMemory` 判活(stale/changed/ok)。
2. 记忆数 <50 → 全部整句注入。
3. 否则做两层渐进式披露:`selectFullText`(user/feedback/locked 全留 + 其余按 `importance*0.995^age` 留存分取 top 40 整句)+ `selectIndexNames`(其余按同一打分只给 title,封顶 200 条,`buildIndexSection` 生成"记忆索引"提示模型按需调用 `memory_read`)。

全程零模型调用,读取阶段完全确定性。

## 蒸馏与合并——两套互补机制

### 回合末统一反思器(生产路径)

**重要发现**:`distill.ts` 导出的 `distill()` 在生产路径里**已无调用点**(仅测试文件用),真正跑在生产里的是 `src/agent/unified_reflect.ts` 的 `reflect()`(只复用了 `distill.ts` 的 `isCatalogNoise` 过滤器)——"蒸馏"逻辑已并入"统一反思器",不是独立的 distill 通道。

- 触发时机:回合末(`src/index.ts:1082-1184`,`maybeReflect`/`runReflector`),而非会话退出。
- DeepSeek 官方 key 每回合都跑(只用 `reflectBusy` 防并发);Volcengine 走自适应节奏(`cadence`,连续无收获则拉长间隔,最多到 `DAO_REFLECT_MAX_INTERVAL`)。
- 一次做:抽取记忆(带 `mergeInto` 指向已有 title 做合并)+ 进展审视(onTrack/advisory)+ 纠错/确认(`corrections`/`confirmed`)。抽出的记忆经 `routeScope` 定层、`upsertMemory` 落盘(`index.ts:1133-1142`)。用 fork 方式复用主模型热前缀缓存。

详见 [middleware.md](middleware.md) §4a。

### 会话启动批量去重(`consolidate.ts`,独立机制)

会话启动期后台(不阻塞)跑的"整层重合并"pass(`maybeConsolidate`,`index.ts:478-493`),按作用域节流(project 20 条/3 天、user 12 条/3 天、knowledge 15 条/3 天),用单独一次 LLM 调用把某作用域全部记忆送去找重叠簇、产出 canonical + supersede 列表,失败绝不影响启动。这是"分层级批量去重",与回合级 reflect 的合并是两套互补机制,不要混为一谈。

## 机械化验证(`validate.ts:9-19`)

只对有 `source` 字段的记忆做:解析 `path#symbol` 中的 path,读实时文件内容 sha256(`hash.ts`)与写入时存的 `sourceHash` 比对——文件读不到→`stale`,hash 不一致→`changed`,一致→`ok`;`validUntil` 过期直接 `stale`;无 `source` 一律 `ok`(不校验)。纯确定性、零模型。

## 衰减/回收(`gc.ts`)

艾宾浩斯留存公式 `retention = exp(-Δdays(lastUsed,today)/S)`,`S = 45*(1+uses)`(17-19 行)。

剪除条件(`shouldPrune`):
- `[DELETED]` 墓碑遗留
- `superseded` 且 `validUntil+7天` 已过
- 留存 <0.3 且 importance<6 且非受保护类型(user/feedback 受保护,但低价值 user 推断——`confidence<0.5` 且 `uses=0` 且 `importance<6`——不受保护)
- **"provisional 耐久门"**:`uses=0` 且距 `created` 超 7 天(`DAO_PROVISIONAL_DAYS`)且 `importance<6` 且 `confidence<0.8` → 快剪,不必等 ~54 天的 Ebbinghaus 周期

GC 在**会话启动时**对三层目录各跑一次(`index.ts:470-472`),确定性、无 LLM。

## 两种"审计",对象不同

- `audit.ts` —— **记忆库健康检查**:对现存 `.md` 逐条打健康标签(superseded/noise/lowvalue/stale/ok),供 `/memory` 斜杠命令展示报告并提示 `/memory delete`(`index.ts:1415-1433`)。
- `memory_audit.ts` —— **会话级可观测追踪**:把 recalled/wrote/distilled/reflected/corrected/consolidated 等事件追加写入 `<sessionDir>/memory-trace.jsonl`(受 `DAO_AUDIT`/`DAO_MEMORY_AUDIT` 开关控制),供事后统计"本会话写了几条、合并率多少、反思跑了几轮"(`formatMemoryReport`/`formatReflectReport`)。

两者互不重叠:一个查"内容质量",一个查"过程日志"。

## 工具:`memory_write.ts` / `memory_read.ts`

- `memory_write`:模型可主动调用,`approval: "auto"`(无需用户确认);内部用串行锁 `withMemLock` 防并发覆盖;写前用 `findSecrets` 拒绝含密钥文本(61-63 行);去重靠 `upsertMemory` 的 title/name **精确键匹配**(不做模糊相似度);支持 `delete:true` 真删除。
- `memory_read`:纯文件读工具,零模型;按 name/title 精确命中给整句,否则按空格拆词做全词 AND 子串匹配返回若干条。

## 用户级 vs 项目级:同一套代码路径

`store.ts` 的 `loadAllMemories`/`upsertMemory`/`writeMemory` 对 project/user/knowledge 三个目录一视同仁调用,区别只是传入目录参数 + 按 `type` 的 `routeScope`。

历史文档提到"借鉴 Claude Code `MEMORY.md`"只是设计思路参照渐进式披露理念——代码里**并没有**真实写出一个 `MEMORY.md` 单文件,当前写入路径始终是每条记忆一个独立 `<slug>.md`,索引段是 `buildIndexSection` 启动时动态生成的展示文本,不是落盘文件。`audit.ts:69` 里 `f !== "MEMORY.md"` 的排除逻辑像是历史遗留防御。

会话开头 system-reminder 里能看到的 `~/.claude/projects/.../memory/MEMORY.md`,属于**外层 Claude Code CLI 自身的记忆功能**,和 dao-code 代码库是两个独立系统,`src/memory/` 里没有任何关联代码——这一点不确定/超出本仓库范围,记录在此供以后核对。
