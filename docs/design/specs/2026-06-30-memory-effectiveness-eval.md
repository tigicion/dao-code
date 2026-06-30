# 记忆效果评测(extraction + recall)

日期:2026-06-30 · 状态:待评审 · 北极星:让 agent 在使用中持续自我迭代成长——而「持续成长」必须可度量

## 背景:功能绿 ≠ 效果好

现有记忆子系统有完整的**功能**测试(salience 门、目录倾倒过滤、密钥过滤、upsert 去重、GC 保护、注入 cap、纠错闭环 supersede/revise/touch),全部走 fake `streamChat`、零 API、CI 常绿。但这些只证明「管道接对了」,**没有一项度量效果**:

- 给一段真实开发对话,反思器到底抽没抽出该抽的耐久事实?有没有把一次性/噪声当记忆?画像(跨项目用户特征)能不能自主抽出?
- 一个真实记忆库 + 一个语境,当前注入到底把不把高价值、相关的记忆送进了上下文?stale 有没有被排除?

已知证据表明效果有缺口:某真实会话里「我有 iPad、持续给 2 岁孩子做游戏」这条画像,模型**没有自主抽出**,是用户提醒后才记的(见 [[user-profile-extraction-and-consolidation]] 动机)。功能测试永远抓不到这种缺口——它需要**效果评测**。

## 目标

1. **提取效果可度量**:给真实(脱敏)对话,跑真实 `reflect`/`distill`,用「金标准 + LLM 评审」双轨打分:must-extract 召回、画像事实召回、must-not 精确率、type/scope 正确性、单条质量。
2. **召回效果可度量**:给真实(脱敏)记忆库 + 语境,跑真实注入选择,确定性度量「高价值有没有挺过 cap / stale 有没有排除 / 排序合不合理」,并诊断「当前无检索注入留下的语境相关性缺口」。
3. **先诊断后固化**:现在跑一次拿基线 + 弱点地图;同时把评测留在仓库当回归,守住记忆质量不退化。

## 非目标(YAGNI)

- **不**改记忆系统本身的行为(本 spec 只加评测;相关性缺口暴露后是否做 scope-tagging 检索是另一条线,见 [[knowledge-scope-tagging]] backlog)。
- **不**把打分跑批塞进 CI(走真实 V4 Pro、要 profile 鉴权、非确定、花钱)。CI 只跑评测**纯逻辑**的单测。打分跑批离线,和现有 `evals/` 一样手动触发。
- **不**做 embedding 检索/向量库(当前注入无检索,我们是度量这个缺口,不是顺手实现它)。
- **不**追求大规模语料;先少量高质量真实 case(几个),够拿出基线和弱点即可。

## 架构总览

新建 `evals/memory/`,与 `evals/` 平级。和现有 evals 不同:**不拉起完整会话**,而是直接调记忆函数的纯/可注入接缝,用**真实 V4 Pro** 模型(经 profile 鉴权)。纯逻辑部分进 vitest(CI、零 API);打分跑批离线手动触发。

```
evals/memory/
  run.mjs                 # 跑批入口:node evals/memory/run.mjs [extract|recall] [--local]
  extract.mjs             # 提取评测:真实 reflect/distill → 打分
  recall.mjs              # 召回评测:真实注入选择 → 打分(A 确定性闸 + B 相关性缺口诊断)
  lib/
    transcript.mjs        # events.jsonl → messages[];脱敏器(纯函数,单测)
    judge.mjs             # LLM 评审器(新):rubric → V4 Pro → 结构化 JSON 分数(可注入 streamChat 单测)
    metrics.mjs           # P/R、覆盖度、中位/方差聚合(纯函数,单测)
    creds.mjs             # 复用 resolveCredential 取 profile 凭证(薄封装)
  fixtures/
    extract/<case>/       # 输入对话 + 金标注(脱敏后进仓)
      conversation.jsonl  # 脱敏后的 events.jsonl 子集
      gold.json           # { mustExtract:[...], mustNotExtract:[...], profileFacts:[...], existing:[...] }
    recall/<case>/
      store/*.md          # 脱敏后的记忆库
      context.json        # { task:"...", valueGold:[names], relevanceGold:[names] }
  runs/<ts>/              # 跑批证据:原始抽取、评审理由、逐 case 分数
  report.md              # 生成的报告
  README.md
  *.test.mjs             # 纯逻辑单测(进 CI,被 vitest.config.ts 的 evals/**/*.test.mjs 收)
```

数据流:
```
提取:conversation.jsonl → transcript 适配 → messages[]
      → reflect(streamChat=真实V4Pro, messages, existing, today) → 抽出记忆
      → 打分:gold 逐条召回(judge 判语义覆盖) + mustNot 精确率 + rubric 单条质量
      → report.md(画像召回 / 事实召回 / 精确率 / type-scope / 质量分,各含 K 次中位+方差)

召回:store/*.md + context.task
      → loadAllMemories + validateMemory → selectForInjection/FullText/IndexNames → 注入集
      → A 轨(确定性闸):valueGold 对注入集做 P/R(cap/stale/排序)
      → B 轨(judge 诊断):relevanceGold(语境相关) vs 实际注入 → 相关性缺口,仅报告不设闸
      → report.md
```

## 组件详述

### 1. 会话适配器 `lib/transcript.mjs`(纯函数,单测)

- `toMessages(events: Event[]): {role, content}[]` —— 把 `events.jsonl` 解析后的事件转成 `reflect`/`distill` 吃的形状:
  - `t:"user"` → `{role:"user", content:text}`
  - `t:"assistant"`(content 可能为 null,带 toolCalls)→ `{role:"assistant", content: content ?? toolCalls 摘要}`(toolCalls 序列化成简短文本,保留工具名+关键 args,丢冗长 args)
  - `t:"tool_result"` → `{role:"user", content: "[工具 ${name} 结果] ${截断的 content}"}`(截断到 N 字符,避免单条爆长)
  - `t:"turn_end" / "notice"` → 丢弃(notice 是反思注入痕迹,不该喂回)
- `redact(events: Event[], opts): Event[]` —— 脱敏:用 `findSecrets`(复用 `src/permissions/secrets.ts`)抠密钥;把绝对 home 路径替换成 `~`;敏感专名按一张可配置映射表替换(如真实项目名→代号),但**保留耐久事实语义**(画像类事实改写为等价表述,不删)。脱敏是产出**进仓 fixture** 时离线跑一次的工具,不在评测热路径。
- `windowMessages(msgs, maxChars)` —— 尾部窗口截断,对齐 `reflect` 内部 24000 字符窗口逻辑,保证喂进去的和线上一致。

### 2. LLM 评审器 `lib/judge.mjs`(新建,可注入 streamChat 单测)

- `judge(p: { streamChat, config, model, rubric, payload, today }): Promise<JudgeResult>` —— 通用打分:把 `rubric`(提示模板)+ `payload`(待评对象)拼成 messages,调模型,强制结构化 JSON 输出,容错解析(复用 `parseReflectResult` 同款括号匹配兜底思路),返回 `{ scores: Record<string, number>, verdicts: {...}[], rationale: string }`。
- 两个专用 rubric:
  - `factCoveredRubric(fact, extractedMemories)` → 判「这条金标事实是否被任一抽出记忆**语义覆盖**」,返回 `{ covered: boolean, byTitle?: string, why: string }`。**金标匹配靠它,不靠脆弱字符串对比。**
  - `memoryQualityRubric(memory)` → 给单条抽出记忆打质量分:`{ durable:0-1, typeScopeCorrect:0-1, notCatalogDump:0-1, actionable:0-1, why }`。
  - `relevanceRubric(context.task, memory)` → 判「这条记忆对该语境是否真相关」`{ relevant: boolean, why }`(召回 B 轨用)。
- **非确定性处理**:`judge` 调用方跑 K 次(默认 K=3,`EVAL_JUDGE_K` 可调),`metrics.mjs` 取**中位**做主指标 + 报告**方差/分歧率**;判 boolean 的取**多数票**。
- 鉴权:经 `lib/creds.mjs` → `resolveCredential` 拿 profile key,和现有 evals 一致;无凭证则明确报错提示先 `dao /login`。

### 3. 指标 `lib/metrics.mjs`(纯函数,单测)

- `precisionRecall(predicted: Set, gold: Set): { p, r, f1 }`
- `aggregate(perRun: number[]): { median, mean, stdev, min, max }`
- `majorityVote(bools: boolean[]): { value: boolean, agreement: number }`
- 提取汇总:`extractionMetrics({ goldCovered, mustNotHit, profileCovered, qualityScores })` → 画像召回、事实召回、must-not 精确率、type/scope 正确率、质量均分。
- 召回汇总:`recallMetrics({ injected, valueGold, relevanceGold })` → A 轨 valueGold P/R/F1;B 轨 relevanceGold P/R + **相关性缺口** = relevanceGold 中**未被注入**的占比。

### 4. 提取评测 `extract.mjs`

对每个 `fixtures/extract/<case>`:
1. `conversation.jsonl` → `toMessages` → `windowMessages`。
2. 跑真实 `reflect({ streamChat: 真实流, config, model, messages, existing: gold.existing, today, fork:false })` 得 `result.memories`。(P1 主打 `reflect`;`distill` 同接缝可选追加,跑 `distill(...)` 得 `Memory[]`,共用同套打分。)
3. 打分:
   - **gold 召回**:对 `gold.mustExtract` 每条,`factCoveredRubric` 判有没有被覆盖 → 召回率。
   - **画像召回**:对 `gold.profileFacts` 每条同上,**单列**(直击已知弱点)。
   - **mustNot 精确率**:对抽出的每条,judge 判是否命中任一 `gold.mustNotExtract`(噪声/一次性/倾倒)→ 噪声率,精确率=1-噪声率。
   - **type/scope 正确性**:被覆盖的 mustExtract,比对抽出记忆的 `type`(经 `routeScope` 映射 scope)与金标期望。
   - **单条质量**:`memoryQualityRubric` 对每条抽出记忆打分,取均值。
4. K 次重跑,`metrics.aggregate` 出中位+方差,写 `runs/` + `report.md`。

### 5. 召回评测 `recall.mjs`

对每个 `fixtures/recall/<case>`:
1. 把 `store/*.md` 写进临时目录(或直接 `parseMemoryFile` 加载),`loadAllMemories` + 逐条 `validateMemory`(against fixture 自带的 workspace 或跳过 source 校验)得 `{mem, verdict}[]`。
2. 跑真实注入选择:`selectForInjection` / `selectFullText` / `selectIndexNames` → 注入集(名字集合)。
3. 打分:
   - **A 轨(确定性闸)**:`context.valueGold`(人工标的「按价值该进 top-N 的记忆名」)对注入集做 P/R/F1。同时断言:`verdict:"stale"` 的一律**不在**注入集(硬规则);高 importance 的没被 cap 挤掉。
   - **B 轨(judge,仅诊断)**:对 store 每条,`relevanceRubric(context.task, mem)` 判是否语境相关 → `relevanceGold'`(模型判的相关集,和人工 `context.relevanceGold` 交叉校准);算**相关性缺口** = 相关但未注入的占比。**永不设闸**(度量已知架构缺口,非回归点)。
4. 写 `report.md`。

### 6. 跑批入口 `run.mjs` + 报告

- `node evals/memory/run.mjs extract` / `recall` / 无参=两者。
- `--local`:不读 `fixtures/`,改读配置指向的本地真实 session(`~/DaoProject/*/.dao/sessions/*/events.jsonl` + 对应 `.dao/memory`),做更丰富诊断(本地真实数据不进仓)。
- 环境:`EVAL_JUDGE_K`(默认 3)、`DEEPSEEK_MODEL`(默认 deepseek-v4-pro)、`EVAL_MEMORY_TIMEOUT_MS`。
- 报告 `report.md`:逐 case + 汇总;每个软指标带「中位 (±方差) / K 次」;A 轨 PASS/FAIL 闸;B 轨缺口数值。`runs/<ts>/` 存原始抽取 JSON + 每次 judge 的 rationale,便于人工复核「分数是不是公道」。

## 金标准制备(诚实性关键)

评测只和金标一样诚实。流程:**Claude 起草、用户抽查**。

1. 从最丰富真实 session(`slide/…mxk0`、`slide/…yah0`、`bubble-machine/…m94s`)各提炼 1 个 case。
2. 我跑脱敏器 → 人工通读脱敏后对话 → 起草 `gold.json`:列出该会话里**客观该抽**的耐久事实(must-extract,标 type/scope)、**明显该滤**的噪声(must-not)、以及**画像类**事实(profile-facts);召回侧起草 `valueGold`/`relevanceGold`。
3. 用户**抽查 must-extract / must-not 两份清单**(评测诚实性全靠这步),改完定稿。
4. 金标 case 数量先少(extract 3 个、recall 2-3 个),够拿基线即可;后续可加。

## 测试策略

- **进 CI(vitest,零 API)**:`transcript.test.mjs`(toMessages 各事件映射 + redact 抠密钥/路径/保留语义)、`judge.test.mjs`(用 fake streamChat 喂固定 JSON,验 rubric 拼装 + 容错解析 + 多数票/中位)、`metrics.test.mjs`(P/R/F1、aggregate、majorityVote、缺口算法)。被 `vitest.config.ts` 现有 `evals/**/*.test.mjs` glob 收。
- **离线打分跑批(手动)**:`run.mjs` 跑真实模型,产 `report.md`。不进 CI。
- 回归:全量 vitest 绿;新增 .mjs 单测全绿;`report.md` 能在有 profile 的机器上跑出来。

## 风险与缓解

- **评审非确定/裁判飘**:K 次中位+方差+多数票;金标打底(must-extract/must-not 的覆盖判定有人工清单兜)。报告露 rationale 供人工复核裁判是否公道。判 boolean 优于让模型直接给连续分(更稳)。
- **金标偏差污染结论**:金标 Claude 起草→用户抽查;case 少而精;`report.md` 附原始抽取,结论可被人工推翻。
- **脱敏漏密钥/泄个人信息**:脱敏器复用 `findSecrets`;进仓 fixture 人工通读把关;真实本地数据走 `--local` 不进仓。
- **真实模型调用花钱/慢**:case 少、K 默认 3、离线手动触发;有超时。

## 取舍记录

- 直接调 `reflect`/`distill`/`select*` 接缝,而非拉完整会话:这些函数 streamChat 可注入、选择函数纯,效果评测要的就是这一层,拉会话徒增噪声与成本。
- LLM 评审做金标语义匹配,而非字符串/embedding:抽出记忆和金标事实表述必然不同,字符串对比脆、embedding 是另一套基建;judge 判「语义覆盖」最贴合且复用同一鉴权。
- 召回相关性缺口只诊断不设闸:当前注入本就无检索,把它当回归点会逼着实现 scope-tagging(超范围);先量化缺口给未来决策。
- 先 P1 提取后 P2 召回:提取弱点(画像抽不出)是已观测的真实痛点,价值更高、直击北极星。
