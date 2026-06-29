# [BACKLOG · 暂缓] 知识沉淀的 scope 标签化 + 语境过滤召回

日期:2026-06-29 · 状态:**deferred(数据先埋,注入侧后做)** · 来源:用户提供的两段参考 + 评估

## 一句话

给跨项目知识库(`procedural` → `~/.dao/knowledge`)的记忆打**粗粒度语境标签**,注入时按当前项目语境**交集过滤 + 平台冲突硬排除**,让 iOS 知识不污染 TS/Android 任务。用标签交集表达粒度,不建分类树。

## 为什么(真实痛点,有证据)

`inject.ts` 现状:会话启动 `loadAllMemories(project,user,knowledge)` → 按 type + 留存分排序取 top-K → 冻结进前缀。**对知识完全无语境过滤**。后果:打开 dao-code(TS 项目)时,`~/.dao/knowledge` 里那批 iOS/Swift/Metal/SpriteKit 知识照样整包注入。knowledge scope 是唯一的跨项目污染向量(user/project scope 本已隔离)。

## 核心设计(取其精华)

- **不新增和 `type` 平级的"开发体系"分类轴**;把语境做成 scope 维度的**可多值标签**。`category(=type)` 答"什么类型的知识",`scope` 答"什么语境下成立"。
- **粒度靠标签数量,不靠树深度**:"iOS 游戏渲染" = `platforms:[ios] + domains:[game,rendering]` 的交集,不是树节点。加新方向只是加 canonical 标签,schema 不动。
- **召回 = 交集过滤 + 冲突硬排除**:
  - 召回 `universal || platforms 空 || platforms∩ctx≠∅`
  - **硬排除** `platforms 非空 && 与 ctx 无交集`(iOS 内存建议进 Android 任务会误导,优先级高于其它轴匹配)。
- **写入时归一化到 canonical**(`ios`/`iOS`/`iphone`/`苹果`→`ios`),绝不在检索时临时归一——漏召回是静默的。

## 关键适配:dao-code 没有"检索时的任务标签"

参考文档假设"当前任务带语境标签来检索"。dao-code 注入是**会话启动一次性冻结、召回无 query**。所以"当前语境"要从 **cwd/项目文件**确定性推导(`*.xcodeproj`/`Package.swift`→ios;`package.json`→web/server)。这是能否落地的枢纽,且契合"启动算定+前缀缓存"模型。

## 为什么暂缓(YAGNI,与暂缓物化视图同一判断)

- 当前知识库 ~24 条、单用户、同质(多为 iOS),到不了"散成几百个同义异形"的规模。
- 急性危害低:v4 pro 不会因一条 iOS 记忆就在 TS 文件写 Swift;token 也不痛。
- 收益要等**跨项目库真的长杂、出现明显"串味"噪音**才兑现。

## 砍掉的过度工程(团队级/上千条才需要)

- 三轴受控词表(platforms/domains/**tech**)+ "新标签申报流程" + 独立同义词治理子系统。
- `tech` 轴(增长最快、最细;title/text 已携带,单独成轴只增维护成本)。
- `domains` 轴可缓(domain 不匹配只是噪音,不误导;**只有 platform 冲突会误导**)。

## 落地时的最小切片(届时按此做)

1. knowledge 记忆 frontmatter 加 `platforms: string[]` + `universal: bool`(REFLECT_TAIL 抽 procedural 时顺带判定)。
2. 写入时轻量归一:`slug()` + 十来条别名小表(非治理子系统)。
3. 启动时从 cwd/项目文件确定性推 `ctxPlatform`。
4. `inject.ts` 过滤:`universal || platforms 空 || platforms∩ctx≠∅`;硬排除冲突。其余轴不动。

## 建议的"先埋"半步(成本低,可现在做)

只在**写入侧**让 REFLECT_TAIL 抽 procedural 时顺带打 `platforms` 标签(不改注入),让数据先积累;等真感到污染了,改动只落 `inject.ts` 一处,数据已就绪。

## 与画像层的关系

画像的**领域层**(技术栈/编码风格/经验水平)同理可标签化(如 `experience_level.ios_game` vs `.backend`);**通用画像层**(沟通偏好等)跨开发体系都成立,不分。

> 关联:[[memory-correction-loop spec]](../specs/2026-06-29-memory-correction-loop.md) 是更高优先级的下一步(让闭环右半=用后纠错成立)。本条是召回精准化的"卫生"前提,排其后。
