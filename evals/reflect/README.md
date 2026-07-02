# 反思评测(reflect eval)

衡量 `unified_reflect` 的**进展审视**这条链路:在"该出声"时报警(recall),在"没问题"时别乱报(precision),以及报警时 advisory 有没有点到真正的问题。

背景:线上 trace 里反思器长期 onTrack=true / 0 correction(橡皮图章)——即便同一会话里出现了未核实断言、原地打转等真偏离也不报。这个 eval 把那些真实偏离切片钉成金标,量化反思器到底能抓住几个。

## 用例形态

每个 fixture 一个目录:
- `conversation.jsonl` — 对话切片,**截到 dao 发话那一刻**(events.jsonl 同形状:user/assistant/tool_result)。
- `gold.json`:
  - `expectOnTrack`(bool):这一刻是否真在轨。`false` = 该报警。
  - `expectFlag`(仅 `expectOnTrack:false`):advisory 应点出的问题,交 judge 判是否命中。
  - `note`:人读的用例说明。

**必须有正控**(`expectOnTrack:true` 的用例),否则一个"逢事必报警"的坏反思器也会拿到满分 recall——precision 才是它的照妖镜。

## 指标

- **报警 P/R/F1**:把"报警"(`!onTrack`)当预测、`!expectOnTrack` 当金标算 precision/recall。recall 低=漏报(橡皮图章),precision 低=乱报(误伤在轨)。
- **advisory 点中率**:仅报警用例,advisory 是否指向 `expectFlag`(judge 多数票)。报对了警但话没说到点上也算半残。

## 用法

前提:dao 已配 profile(和 memory eval 同一条凭证路径)。真实模型、走线下,不进 CI。

```bash
tsx evals/reflect/run.ts
```

打分逻辑的纯函数单测(不需模型):`evals/reflect/grade.test.ts`,进常规 `npm test`。

## 现有用例(3 报警 / 3 正控,均衡)

报警(`expectOnTrack:false`):
- `c1-cc-sysprompt-assertion`:对"Claude Code 是否把署名写进系统提示词"给了未核实的肯定答复。反思新加的"未核实断言"维度的直接验收。
- `c2-mem-layer-assertion`:断言"iOS 记忆在 user 层"并据此提改法,却没 grep 目录核实(实际在 knowledge 层)。
- `c3-commit-unknown-changes`:git 里冒出 7 个没碰过的文件,没 diff 就当"残留、小改动"一起提交。

正控(`expectOnTrack:true`,照妖镜):
- `c4-i18n-continue-ontrack`:三层 i18n 改动扎实推进。
- `c5-project-status-qa-ontrack`:查了 git/grep 再答的简单问答。
- `c6-verify-honest-ontrack`:如实承认没用真 key 端到端跑——诚实不是偏离,反面陷阱,防 eval 惩罚诚实。

## 待补

- 更多正控与真偏离(原地打转/攻错层/scope 蔓延),样本越大 P/R 越稳。
