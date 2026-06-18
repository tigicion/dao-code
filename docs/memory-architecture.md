# 记忆模块架构(写入 / 读取全景)

> 本文是 DAO CODE 记忆模块的目标架构,综合了一轮深入设计讨论的结论。
> 现有机器底子好(相似度分带去重、艾宾浩斯衰减、分层、staleness),本架构是围绕
> **三处结构缺陷**重构数据流、复用现有组件——不是重写。

## 缓存不变量(塑造一切)

- 固定前缀(系统提示主体)永远字节稳定。
- 注入内容(高价值全文 + 全量索引)在**会话开始算定、整会话固定**,待在会话固定区。
- 按需读的全文像普通工具结果一样追加在对话里。
- **无"可刷新块"、无"写触发刷新"、无缓存张力**——索引中途不更新(新写入本就在对话里,下个会话才进索引)。

## 要修的三处结构缺陷

1. **写入时机**:原仅退出时蒸 → 冷缓存全价(实测命中 0%)。→ 改为**热回合边界 + 增量 + 后台**。
2. **读取是死快照**:启动注入一次性 top-N 全文,无法随 session 焦点漂移浮出**之前沉淀、后来才变相关**的长尾。→ 改为**高价值全文 + 全量索引常驻**(渐进式披露,如 skill),长尾按需 `memory_read`。
3. **没有耐久门**:首次出现即落盘 → 把中途会被推翻的状态记成事实。→ 加 **provisional→confirmed** 门。

---

## 一、写入(WRITE)

```
回合边界监控(确定性·免费·唯一触发源)
  └─ 闸:新token≥T(扣spill) / verify通过 / 压缩前 / max-gap兜底 ── 否则跳过(多数回合跳过)
        │ 命中
        ▼
  后台 fork 蒸馏(distill.ts):同模型(pro)·热缓存(~99%命中)·只蒸增量切片·不阻塞
        │ 永远热(只在回合边界跑)→ 永远 pro fork,无冷路径、无 flash 兜底
        ▼ 候选 {text, type, importance(粗档), confidence}
  salience 门:以 type 为先验(feedback/user 天然留);长尾按粗档 importance(中途严/收尾松)
        ▼
  去重 upsert(store.ts,写路径不变):相似度分带 ≥0.9合并 / 0.2–0.9 flash裁判 / <0.2新
        │ flash 成本控:批量裁判 + (A,B)verdict 缓存 + 推迟到"晋升"才精确去重
        │ 合并 → uses+1
        ▼
  耐久门:落盘 status=provisional → 二次出现(uses↑)/verify引用 → confirmed;窗口内没复现 → 丢
        ▼
  分层 = 作用域(type 驱动):本项目事→项目级 / 用户事→用户级 / 跨项目通用→用户·知识库级
        │ confidence 不决定层,只压低 importance、推迟晋升到全局
        ▼
  写 .md(status 扩 provisional)

后台常驻:GC(gc.ts)艾宾浩斯衰减 S=45*(1+uses)、偏重 uses + 剪枝 + 软上限按留存淘汰
会话最后一个回合边界:若有未达阈值的尾巴,用更低 floor 收一次(仍热)。退出时不再触发蒸馏。
```

要点:
- **触发唯一来源** = 回合边界监控层(与挑战者/纠偏 fork、advisor 共用同一信号源)。
- **importance 退居 tiebreaker**:type(确定性先验)+ uses(行为真值)为主;importance 改 3 档粗粒度,只当冷启动先验;留存偏重 uses,猜错会被时间纠偏。
- **tier 与 confidence 解耦**:层级走作用域(type 驱动);confidence 喂 provisional/晋升,不决定存哪层。
- **flash 成本**:批量裁判 + verdict 缓存 + 推迟到 confirmed 晋升时才精确去重,频率高也不线性涨;计入 `DAO_MAX_BUDGET`。

---

## 二、读取(READ)—— 零模型、零 flash、渐进式披露(像 skill)

```
存储:已有的分层 .md(项目级 + 用户级[+ 知识库]),project 覆盖 user
        │
会话开始,一次性算定注入(整会话固定,进会话固定区):
  ① 高价值全文(小额):user / feedback / locked / top —— 直接给正文
  ② 全量一行索引(借 CC MEMORY.md):跨所有层,每条 `名字 — 一句事实 [tier]`
       封顶 ~150–200,超了按 importance×0.995^age 砍;stale剔除 / changed加"(可能过期)"
        │
会话推进、焦点漂到某话题:
  主 agent(pro,正跑着·缓存热 = 免费的相关性判断)在索引里看到那条变相关的老记忆
        ▼
  memory_read(name):纯文件读,零模型/零 flash → 正文作为普通工具结果追加
        ▼
  解决缺陷 #2:启动 top-N 没选中的长尾,随 session 变相关时靠"常驻索引 + 模型自判"浮出
            —— 不需要 embedding/相关性引擎,读路径一个模型调用都没有
```

要点:
- **相关性判断让主 pro 在常驻索引上自己做**——它本就在跑、缓存是热的,等于免费的相关性引擎。
- **读路径无任何模型调用**:`memory_read` 是纯文件读;不做 flash 语义搜索(冷上下文、花钱、吃不到缓存)。

---

## 三、存储与数据模型

- **.md 是真身(source of truth)**,分层目录已存在:`<项目>/.dao/memory/` + `~/.dao/memory/`(+ 知识库)。`loadFromDirs` 合并,项目覆盖用户。
- frontmatter:`type / importance(粗档) / uses / confidence / lastUsed / locked / status(active|provisional|confirmed|superseded)`。
- **索引 = 这些 .md 的生成视图,不是第二份存储**;横跨本会话可见的所有层,每行标 tier。索引行直接用记忆的一句话 `text`(distill 产出本就是一句话),无需额外 description 字段。
- **零迁移**:同文件、同目录、同 frontmatter;仅 `status` 扩一个值。

---

## 四、复用 / 新增 / 借 CC

| | 内容 |
|---|---|
| 复用(不动) | distill 增量、相似度分带去重 + flash 裁判、艾宾浩斯衰减+剪枝、分层目录、staleness、memory_search |
| 改时机 | 触发挪到热回合边界 + 后台 + 增量(治冷缓存全价);退出不再蒸 |
| 新增 | provisional→confirmed 门、软上限淘汰、flash 批量/缓存/推迟到晋升、tier 改作用域驱动、importance 改粗档+退为 tiebreaker(留存偏重 uses) |
| 借 CC | 全量一行索引(渐进式披露,如 skill)+ 高价值全文两层 + `memory_read` 按需读 |

---

## 五、落地状态

1. ✅ **读取层**:`selectFullText` + `selectIndexNames` + `buildIndexSection` + `memory_read` 工具。解缺陷 #2。(`9b77c59`)
2. ✅ **写入热边界 + 增量 + 后台**:`capture_policy` + 回合边界 `captureMemories`,退出不再蒸。解缺陷 #1。(`0c263e7`)
3. ✅ **耐久门 + tier 解耦 + importance 粗档**:provisional=uses0、confirmed=uses≥1,GC 快剪未确认;routeScope 只按作用域;importance 3 档。解缺陷 #3。(`d708777`)
4. ✅ **反思层**:`turn_health`(确定性回合监控,治"活动≠进展")+ 挑战者/纠偏 fork(同模型热缓存,结论作 advisory 参考)。
   - 挑战者:连续失败/同错复发触发(`DAO_FAIL_STREAK`/`DAO_REPEAT_ERR`)。
   - 纠偏者:仅长任务、每 N 轮(`DAO_REFOCUS_EVERY`,默认 0=关)。
   - `DAO_REFLECT=0` 全关;一次性/eval 不反思。additive 接入,不动既有 idle advisor。

> 反思层是独立子系统(非记忆模块),与记忆捕获共用同一回合边界监控点。
