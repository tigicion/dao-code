# 记忆纠错闭环 + 强化信号校准

日期:2026-06-29 · 状态:待评审 · 北极星:让 agent 在使用中持续自我迭代成长

## 背景:闭环缺了右半

自我成长是一个闭环,缺一环就退化成囤积:

```
抽取 → 整理 → 召回 → 应用 → 用后反馈 → 强化/纠错 → 回到抽取
```

dao-code 现状:抽取 ✅、整理 ✅(去重/合并 pass/真删除)、召回 ⚠️(无语境过滤,见 backlog)、应用 ✅、**用后反馈/纠错 ❌**。我们已把闭环左半(写入+整理)做扎实,右半是空的。**没有右半,左半再强也只是高质量囤积器,不是成长器。**

### 证据:强化信号奖励"重复"而非"有用"

`uses`/`lastUsed` 仅在 `store.ts:81-83`(`upsertMemory` 命中既有键 = 同一事实被**再次抽出**)时更新。召回/注入侧不回写。留存 `S = 45*(1+uses)`、按 `daysBetween(lastUsed, today)` 衰减。后果:

1. 真正有用但只陈述过一次的知识(uses=0)按时间衰减,哪怕每会话被注入被用上——**召回并用上 ≠ 强化**。
2. 反复被重新推导的"显而易见"知识反而 uses 涨、留存久。**信号方向偏了:奖励复述频率,不奖励使用价值。**

并且记忆"过期"只靠两条:启动期 source-hash 比对(`validateMemory`)、时间衰减。**没有任何路径让"干活中发现某条记到的事实其实错了 → 当场纠正那条记忆"。**

## 目标

1. **纠错**:当本会话的实测证据(工具输出/命令结果/文件内容)推翻一条已记忆的事实时,反思器认领并 supersede/改写该条,使下个会话反映现实。
2. **确认强化**:当一条已记忆被本会话实测**证实并依赖**时,刷新其 `lastUsed`(=按"被验证使用"续命),把强化信号从"被复述"挪向"被用且成立"。
3. **可观测**:纠错/确认落 trace,可事后复盘(接续已有 reflected note / consolidated 可观测性)。

## 非目标(YAGNI / 防过度工程)

- **不做 outcome 归因**(哪条召回的记忆导致了会话成功)。20 条注入里谁立功无法干净归因,硬做=RL 式过度工程,噪音大收益虚。
- **不做"召回即强化"**(等于奖励一切被注入的,无区分度)。
- 不新增独立的纠错 LLM 调用——纠错/确认搭车现有的回合末统一反思器(REFLECT_TAIL),零新增调用。
- 不动召回侧语境过滤(那是另一条线,见 `ideas/2026-06-29-knowledge-scope-tagging.md`,暂缓)。

## 设计

纠错与确认都搭车 `unified_reflect.ts` 的 REFLECT_TAIL——它每回合末作为 fork 跑、看完整对话 + 注入的记忆块 + `existing` 候选标题,天然具备判断"哪条旧记忆被实测推翻/证实"的全部上下文。

### 一、REFLECT_TAIL 增第三段:纠错与确认

在现有「一、进展反思」「二、记忆(抽取+mergeInto)」之后,加「三、对已有记忆的纠错与确认」:

```
## 三、对已有记忆的纠错与确认(只在【有本会话实测证据】时)
对照上面列出的【已有记忆】,仅当本会话的工具输出/命令结果/文件内容给了具体证据:
- corrections:某条已有记忆的事实被实测【推翻或需修正】→ 给 {target: 该条 title, action: "supersede"|"revise", newText?: 改写后的完整事实(revise 必填), reason: 引具体证据}。
  · 极保守:只在证据确凿时纠错(错纠会污染全局);拿不准不纠。supersede=该事实已不成立;revise=部分过时需更新。
- confirmed:某条已有记忆被本会话实测【证实且实际依赖】→ 列其 title。只列真正用上且成立的,不是"看到了"。
一切无据 → corrections: [], confirmed: []。
```

输出 JSON 增两字段:`"corrections": [...]`,`"confirmed": ["title", ...]`。

### 二、解析(reflect_result.ts)

`ReflectResult` 增:
```ts
corrections: { target: string; action: "supersede" | "revise"; newText?: string; reason: string }[];
confirmed: string[];
```
逐条独立容错(坏条目丢);`revise` 缺 `newText` 降级丢弃;`action` 非法丢弃。无则空数组。

### 三、落地(index.ts 反思持久化处,复用现有原语)

在反思器结果落盘(现 `reflectMemToCand`/`upsertMemory` 那段)之后:

- **corrections**:按 `target`(title)在 existing 里定位记忆(`e.title===target || e.name===slug(target)`)。
  - `supersede` → `supersedeMemory(dir, name, name, today)`(supersededBy 指向自身=纯失效;软删可追溯,GC 7 天宽限后清)。
  - `revise` → `upsertMemory` 写入同 name 的新 text(命中既有键即覆盖增强)。
  - 找不到 target → 跳过(不抛)。**保守闸**:`corrections` 单回合上限(如 3 条),超出只取前 N 并记 trace,防一次误判批量毁库。
- **confirmed**:对每个命中的 title,刷新其 `lastUsed = today`(续命;不强行 +uses,避免和"重复"信号混淆)。新增 store 原语 `touchMemory(dir, name, today)` 或复用 upsert 的 lastUsed 更新路径。

### 四、可观测(memory_audit.ts)

`reflected` 事件增 `corrected?: number`、`confirmed?: number`;或新增 `corrected` 事件 `{ts, target, action, reason}`。`/audit` 报告展示"本会话纠错 N 条 / 确认 M 条 + 理由"。沿用 consolidated 的展示风格。

## 数据流

```
回合末 REFLECT_TAIL(一次 fork)
  → onTrack/advisory/note(已有)
  → memories + mergeInto(已有)
  → [新] corrections(supersede/revise 被实测推翻的旧记忆)
  → [新] confirmed(被实测证实的旧记忆 → touch lastUsed)
落盘:upsert 新记忆(已有) + 应用 corrections(supersede/revise) + touch confirmed
  → trace: reflected{...,corrected,confirmed}
```

## 测试

- `reflect_result.test.ts`:解析 corrections/confirmed;坏条目降级(revise 无 newText 丢、action 非法丢);缺失 → 空数组;不破坏既有 onTrack/advisory/note/memories。
- `store.test.ts`:`touchMemory` 只更新 lastUsed 不改 text/uses;不存在的 name 不抛。
- 集成(index 反思持久化):corrections supersede → 目标 status superseded;revise → 同 name text 更新;confirmed → lastUsed 刷新;corrections 上限闸生效。
- `memory_audit.test.ts`:reflected 带 corrected/confirmed 计数汇总 + 报告展示。
- 回归:全量 vitest 绿;tsc 干净。

## 风险与缓解

- **错纠污染全局**(最大风险):纠错是半破坏性。缓解——(a) 极保守 prompt 纪律 + 必须引实测证据;(b) supersede 软删可追溯/可恢复,不硬删;(c) 单回合 corrections 上限;(d) reason 落 trace 可复盘。
- **confirmed 噪音**:模型可能滥列。缓解——prompt 限定"真正用上且成立",且 confirmed 只 touch lastUsed(温和续命),不进激进强化。
- **与 source-hash staleness 重叠**:source-hash 抓"来源文件变了",纠错抓"实测发现事实错了",二者正交互补,不冲突。

## 取舍记录

- 搭车 REFLECT_TAIL 而非独立 pass:零新增 LLM 调用、时效最好(会话内即纠,下个会话已正)、复用已有 fork 上下文。
- supersede 而非 hard delete:纠错可能误判,需可追溯/恢复;hard delete 留给模型主动删单条。
- confirmed 只 touch lastUsed,不 +uses:把"被验证使用"和"被重复抽出"两个信号分开,不混淆留存语义。
