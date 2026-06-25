# 统一反思器 + 记忆存储重构 — 设计定稿

> 把【纠偏者 + 记忆蒸馏 + 用户重提检测】合成**每回合末一个 fork**(自适应 1–3 回合);保留轮内卡住检测;同时把记忆存储/召回从"相似度驱动"改为"LLM + title 驱动",彻底删掉 bigram 相似度。

定稿日期 2026-06-25。决策全部已与用户确认。

---

## 0. 一句话

**每个用户回合末跑一个 fork,既反思(有问题才说)又抽记忆(语义去重/合并);轮内卡住仍由 assessTurn 细粒度兜;记忆一文件一条、靠 title 召回、靠 LLM 合并,不再用相似度。**

## 1. 动机

当前复杂度堆在两处:记忆侧 `shouldCaptureMemory` 4 触发 + activeWrite 抑制 + token 阈值 + `newTokens<=0` 守卫;反思侧挑战者/纠偏者/reply-challenger 各一套门控;记忆召回又叠了全文层/索引层/相似度 top6/stale 校验。

核心洞察:**这些"退一步看一眼"的活该合并;而记忆的语义判断该交给 LLM,不是字符相似度。**

## 2. 反思器(回合末)

```
每个用户回合末(runTurn 返回后,非 argvPrompt/非子代理):
  按自适应节奏决定是否跑;跑则后台 fork(复用主前缀热缓存)→ ReflectResult:
    { onTrack: bool,
      advisory: string|null,    // onTrack=true 必为 null;否则 ≤8 行
      memories: Mem[] }          // 抽取 + 内含合并意图(见 §5)
  → advisory 非空 → 入队,下回合边界 append-only 注入(沿用现有 drain 模式)
  → memories → 落盘(§5 的 LLM 合并逻辑)
  → 写 reflect-trace.jsonl 一行
压缩在即:同步 await 跑(先抢救,再压),无视节奏计数。
```

### 2.1 自适应节奏(默认每回合,空闲回退 ≤3)

纯函数状态机 `reflect_cadence.ts`:
```
interval∈[1,3] 起始 1;counter 每回合 +1;counter≥interval 时【跑】并 counter=0。
跑完按产出更新:
  安静(onTrack 且 memories=0)        → interval = min(3, interval+1)
  有产出(advisory≠null 或 memories>0) → interval = 1
```
回退只在连续安静后发生;跳过的回合下次 fork 读完整上下文补抽,**记忆只迟不丢**;advisory 最多迟 ≤2 回合。`DAO_REFLECT_EVERY=1` 关自适应、`DAO_REFLECT_MAX_INTERVAL` 调上限。

### 2.2 完整 tail prompt(作为 user 消息追加在主对话后,fork 命中热缓存)

```text
你对当前对话做一次【回合末反思】,产出两件事。只输出一个 JSON 对象,无其它文字。

## 一、进展反思(独立怀疑视角;看完整上下文;只评估,不干活)
1) 复述「现在在做什么、最初目标是什么」(别曲解成更蠢的版本)。
2) 仅当【确有问题】挑 1–3 点,每条扎根具体证据(引文件/报错/命令):
   · 在原地打转/反复试同一类改动?改文件≠进展——验收/错误状态真变了吗?
   · 攻错了层?把未验证假设当事实?给根因「可能是 X,因为 Y」。
   · 跑偏最初目标 / 镀金 / scope 蔓延?
   · 用户在重复表达同一问题没解决?若是,质疑诊断与前提,别叠加修复。
3) 一切在轨或只是新任务 → onTrack=true、advisory=null,绝不硬找茬。
   否则 onTrack=false,advisory ≤8 行,结尾给最小下一步。是参考不是命令。

## 二、记忆(从最近进展抽尚未记录的耐久事实;并主动判断是否【并入已有】)
下面是已有相关记忆(标题 + 正文),供你判断新事实是【全新】还是【延伸/涵盖某条】:
{已有记忆候选:title + text}
按 5 type 归类(user/feedback/procedural/semantic/episodic,选错污染全局)。
- 每条给:title(≤1 行概要)、text(完整事实;feedback 带"为什么/怎么用")、type、importance、confidence?、source?
- 若新事实延伸/涵盖已有某条 → 设 mergeInto=该条 title,text 写【合并增强后的完整版】。
【绝不记】一次性/情绪、项目专属写成 user/feedback、dao 自身实现细节当用户偏好、显而易见/代码已写明、工具/技能清单(目录倾倒)。无可记 → memories: []。

## 输出(严格 JSON)
{ "onTrack": true, "advisory": null,
  "memories": [ { "title":"…","text":"…","type":"feedback","importance":9,"confidence":0.9,"source":"可选","mergeInto":null } ] }
```
> 纪律:fork 前缀必须与主循环【同一份 tools + 同思考强度】逐字节一致,否则命中崩到 ~1%。两段独立解析(advisory 坏不影响 memories 落盘,反之亦然)。

## 3. 轮内卡住检测(保留,不删)

`turn_health.assessTurn` 维持现状:在 `runTurn` 的 for 循环里**每个工具轮**判连续失败/同错 → 轮内 fork 挑战者。理由:长自主回合(`--goal` 几十轮不回用户)里反思器要等回合末才看,**轮内打转救不了**;卡住检测粒度细到工具轮,该留。

**分工**:轮内=卡住(assessTurn);回合末=方向+记忆(反思器)。`reply_challenge.ts` 整文件删(其"用户重提"职责由每回合反思天然覆盖)。

## 4. 轮内主动压缩(新增)

现状只在回合末查 85% + 反应式(撞超限才压)。长回合中途会超上限不好处理。
**改**:在 `runTurn` for 循环里**每个工具轮之间**主动查一次 size,≥85% 先压再进下一轮(粒度同 assessTurn)。回合末/反应式两条保留作兜底。

## 5. 记忆存储/召回重构(彻底去相似度)

### schema(两字段,无 slug)
```
title: string   // 模型写的 ≤1 行概要,既展示/索引、又派生文件名 slug(title)
text:  string   // 完整事实(feedback 带"为什么/怎么用")
+ type/importance/uses/confidence/created/lastUsed/source?/status/locked(沿用)
```
文件名 = `slug(title)`(可读 + 即 id);**删除"正文截断 40 字"的旧 slug**。

### 存储
- **一文件一记忆**(可读/可 git diff,保留)。
- **内存缓存**:启动 `loadAllMemories` 一次驻内存,写时增量更新;去重/注入读内存,不再每次/每候选全盘扫。

### 去重 / 合并(100% LLM,删 textSimilarity)
- **完全删除 `src/text/similarity.ts`** 及 `memory_read`/`store` 对它的引用(`reply_challenge` 一并删)。
- **upsertMemory**:只做**确定性精确键**去重(同 title/name → 覆盖更新),不再做模糊匹配。
- **语义合并**:由反思器承担——prompt 喂"已有相关记忆候选",模型判 `mergeInto`;命中则用合并后 text 覆盖那条(title 不变、`uses++`、importance 取大)。主动 `memory_write` 工具产生的偶发重复,由下次反思器合并收敛。

### 召回(靠 title,不靠相似度)
- **注入**:沿用两层,但**索引层注入 `title`**(真概要,非截断正文);全文层注入高价值整句。
- **小 N 快路径**:记忆总数 < 50 → 全注入整句,跳过评分/索引层。
- **memory_read**:从模糊打分改为**对 title/text 的子串/精确匹配**(模型在上下文看得到 title,按 title 拉正文)。无相似度。

## 6. demo 用开关与对照

- 新增 `DAO_NO_MEMORY=1`:禁注入 + 禁反思器记忆(供对照)。
- 新增 `DAO_DEBUG_REFLECT=1`:每回合 stderr 打 `[reflect] onTrack/mem/advisory/interval`。

## 7. 如何展示效果

### A. 确定性 e2e 测试(零 API,CI 常驻)
假模型返回固定 ReflectResult,焊死:onTrack→advisory 不注入;drift→注入;memories→落盘;mergeInto→覆盖而非新增;advisory 坏段不影响 memories;cadence 在 1↔3 正确移动。

### B. reflect-trace.jsonl + `/audit reflect`
每回合一行 `{ts,onTrack,advisoryInjected,memExtracted,memMerged,interval,ms,promptTokens,cacheHit}`;`/audit reflect` 汇总「N 回合跑 M 次、advisory X 次、记忆 +Y 合并 Z、命中 95%」。证明「每回合反思但只在该说时说话」。

### C. 「有记忆 vs 无记忆」并排 gif(README 头部,最有冲击)
跨会话:上个会话学到 → 新会话不用说就做对;`DAO_NO_MEMORY=1` 则做错。3 场景覆盖三 type:

| # | type | 上轮写入 | 有记忆 | 无记忆 |
|---|---|---|---|---|
| 1 | feedback | "提交别加 AI 署名" | 无署名直接 commit ✓ | 又加 Co-Authored-By,被骂 |
| 2 | procedural | "bun 二进制 cp 后必须 codesign 否则 killed" | 重建自动重签 ✓ | `zsh: killed`,从头 debug |
| 3 | user | 全程中文、修 bug 先列因再改 | 开口中文、先列因 ✓ | 英文、上来就猜改 |

### D. 反思器现场 demo(`scripts/demo-reflect.tape`)
5 步:正常静默 / 纠正静默记住 / 修一版没好 / "还是不行"打转→才弹 advisory / `/audit reflect` 收尾。对照旧版(每相似输入弹"在轨继续")见噪音清零。

## 8. 落地步骤(TDD)

1. `reflect_result.ts`:ReflectResult 类型 + 容错解析(两段独立降级)。**先测**。
2. `reflect_cadence.ts`:§2.1 状态机(纯函数)。**先测**。
3. 记忆 schema 加 `title` + `slug(title)` 文件名;内存缓存层;**删 similarity.ts**;upsert 改精确键;memory_read 改子串/title;inject 索引层用 title + 小 N 全注入。逐个先测。
4. `unified_reflect.ts`:组 §2.2 prompt(含已有记忆候选)+ fork + 解析 → ReflectResult。fake streamChat 测。
5. `index.ts`:回合末接线(替换 capture+reflect,接 cadence);reflect-trace;`DAO_DEBUG_REFLECT`;`DAO_NO_MEMORY`。
6. 删旧:capture_policy 多触发体系、`reply_challenge.ts`、refocuser 计数(**留 assessTurn、留压缩前同步**)。§4 轮内主动压缩。
7. `/audit reflect` + 端到端管线测试(展示 A/B)。
8. `typecheck && test` 全绿;`demo-reflect.tape` + 「有/无记忆」对照 gif;`bundle:install` 重建。

## 9. 正交后续(做完本设计再做,已记录)

1. **回合中途 steering 流式插入**:把 TUI `queued` 接到 `loop.drainPending`(已存在,现仅子代理 SendMessage 用),让用户回合未完成时的输入在**下一个工具轮边界**注入(append-only、缓存安全)。CC 没有此功能(Issue #30492),DAO 已有底层管线,领先。
2. **反思 advisory 流式展示**:fork 边生成边流到界面一个独立块(像 CC 展示 thinking);上下文注入仍 append-only/回合边界(展示≠注入,解耦)。
3. **默认 commit 署名 `Co-Authored-By: DAO CODE`**:DAO 自身代提交时默认加 DAO 署名尾注(对标 CC 的 Claude 署名)。系统提示现无任何 commit 指引 → 加一行即可,很好做。可设开关关闭。

## 10. 风险

| 风险 | 缓解 |
|---|---|
| 一 fork 干两件事质量稀释 | prompt 分区 + 各自"无则空"出口;两段独立解析;A 测试 + 真跑 trace 看质量 |
| 每回合 fork 成本 | cache-warm ~95%;自适应 1–3 摊薄;长会话约 +¥0.2–0.5 |
| 删相似度后 memory_read 召回变弱 | 模型在上下文已见全部 title,按 title 直取;比模糊打分更准 |
| upsert 精确键去重漏掉近重复 | 由反思器语义合并收敛(下次回合) |
