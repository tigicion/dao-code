# 记忆效果评测(memory eval)

衡量 dao 记忆系统两条链路的质量:
- **提取(extract)**:一段对话经 `unified_reflect` 反思后,该沉淀的事实/画像有没有被抽出来(召回),不该抽的噪声有没有被误抽(精确率),抽出的单条记忆是否耐久、类型/作用域正确、可执行(质量)。
- **召回(recall)**:面对某个任务语境,记忆库里该注入的价值记忆有没有被注入(P/R/F1),已失效的 stale 记忆有没有泄漏进上下文(硬规则,应为 0),以及"语境相关但未注入"的相关性缺口(诊断指标,越低越好)。

打分由 LLM judge 完成(多数票 K 次),因此跑批需要真实模型、走线下,不进 CI。

## 用法

前提:dao 已配好 profile(凭证从 `~/.dao/config.json` + keychain 解析,和交互/现有 evals 同一条路径)。先跑过 `dao /login`,或在 `~/.dao/config.json` 写好 profile。

```bash
# 两条链路都跑
tsx evals/memory/run.ts

# 只跑其一
tsx evals/memory/run.ts extract
tsx evals/memory/run.ts recall
```

跑批遍历 `fixtures/extract/*` 与 `fixtures/recall/*` 每个 case 目录,结果汇总成 `evals/memory/report.md` 并打到 stdout。

## 环境变量

- `EVAL_JUDGE_K`:judge 多数票次数,默认 3。
- `DEEPSEEK_MODEL`:覆盖 profile 里的模型名(judge 与反思都用它)。

## fixtures 结构

- `fixtures/extract/<case>/`:`conversation.jsonl`(对话流)+ `gold.json`(`existing`/`mustExtract`/`mustNot` 金标)。
- `fixtures/recall/<case>/`:`context.json`(任务语境 + `valueGold` + stale 标注)+ `store/`(候选记忆库)。

## 金标制备约定

金标(`mustExtract`/`mustNot`/`valueGold`)由 Claude 起草、用户抽查校正。判定哪条事实"该抽"、哪条记忆"该注入"是主观的,起草只是降低人工成本,最终以用户抽查为准。

## CI 与线下分工

- **CI 只跑纯单测**:`report.test.ts`(纯格式化,零 API)等不依赖真实模型的用例随全量 `vitest` 跑。
- **打分跑批离线**:`run.ts` 调真实模型 + LLM judge,不进 CI,由人手动跑、读 `report.md`。

## 后续增强

`run.ts` 的 `--local` 真实 session 接入(直接读 `~/DaoProject/*/.dao/sessions/*/events.jsonl` 当 extract 输入)尚未实现,先以 `fixtures/` 跑通为准。`listCases` 不跳过 `_` 前缀目录,`_synthetic` 合成样本会一并跑,作冒烟。
