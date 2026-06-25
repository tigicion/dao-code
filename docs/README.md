# DAO CODE 文档

| 目录 | 放什么 | 维护性 |
|---|---|---|
| [`architecture/`](architecture/) | DAO 如何运作的**活参考**(随代码更新):[overview](architecture/overview.md) 总体设计、[memory](architecture/memory.md) 记忆架构、[unified-reflector](architecture/unified-reflector.md) 统一反思器+记忆召回 | 持续维护 |
| [`design/`](design/) | **设计记录**(带日期、不回头维护):`specs/` 各特性的设计规格、`plans/` 对应的实现计划。读历史决策从这里看 | 归档,只增不改 |
| [`case-studies/`](case-studies/) | **能力实证**(带日期):dao 自主完成真实任务的实测案例 + 硬数据(成本/缓存/长任务稳健),含测量方法与复现配方 | 归档,只增不改 |
| [`assets/`](assets/) | 演示 gif 等二进制资源(README 引用) | — |
| [`MAINTAINER-SETUP.md`](MAINTAINER-SETUP.md) | 维护者运维清单(发布、演示录制等) | — |

新增内容放哪:
- 解释"现在怎么运作"的 → `architecture/`(保持与代码一致)。
- 某次特性的设计/计划草稿 → `design/specs/`、`design/plans/`,文件名带日期前缀。
- dao 跑通真实任务的实测/实证 → `case-studies/`,带日期与复现配方。
- 用户怎么用 → 优先写进根目录 `README.md` / `README.en.md`,不堆这里。
