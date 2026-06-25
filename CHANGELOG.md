# 更新日志 / Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.2.0] - 2026-06-25

### 新增
- **统一反思器(回合末一个 fork)**:每个用户回合末跑一个复用主前缀热缓存的 fork,同时【反思进展】与【抽取记忆】。`advisory` 产出门控——在轨就不注入(消灭"在轨,继续"噪音),有问题(打转/跑偏/攻错层)才 append-only 注入下一回合;记忆经语义合并落盘。**自适应节奏**:默认每回合,连续"安静"回退至多 3 回合,一有产出立刻回到每回合(`DAO_REFLECT_MAX_INTERVAL` / `DAO_REFLECT_EVERY=1`)。
- **`/audit reflect`**:汇总 N 回合里跑/跳几次、advisory 几次、记忆新增/合并、当前节奏。
- **开关**:`DAO_NO_MEMORY=1`(禁注入+禁反思记忆,对照用)、`DAO_DEBUG_REFLECT=1`(每回合打 `[reflect]` 决策)、`DAO_REFLECT_SYNC=1`(反思同步完成再继续)。

### 变更
- **记忆系统重构**:记忆加 `title` 字段(≤1 行概要,既展示又派生文件名);**彻底移除字符相似度**——去重改为精确键(同 `slug(title)` 覆盖),"意思相同但标题不同"的语义合并交反思器 `mergeInto`(模型在抽取的同一次调用里,对照全部已有标题判定);召回改为 title 索引 + `memory_read` 关键词匹配;记忆数 < 50 时全量整句注入、跳索引层。
- **反思架构归并**:原"独立蒸馏 + reply-challenger"合入回合末反思器;轮内卡住/长任务漂移仍由 `assessTurn`(工具轮级:连续失败→挑战者、长任务每 3 轮→纠偏者)细粒度兜。
- **轮内主动压缩**:长回合在工具轮之间逼近上限即压,防中途撞上下文上限(此前仅回合末/反应式)。

### 修复
- **后台子代理结果回灌**:headless / `--goal` 路径下,后台子代理完成结果在 loop 回合边界正确回灌主对话(补全实现)。

### 工程
- 设计定稿 + 真模型实证记录 + 架构文档(`docs/`),「有记忆 vs 无记忆」演示 gif;能力实证案例类目。
- 删除 `similarity.ts` / `reply_challenge.ts` / `adjudicate.ts` / `capture_policy.ts` 等已被取代的模块。

## [0.1.20] - 2026-06-21

### 修复
- **单轮长任务也能压缩**:压缩/microcompact 原按 user 轮切,一次性/`--goal` 自主任务只有 1 个 user 轮 → 压缩永不触发、逼近上限会撞墙;现 microcompact 在 user 轮稀少时 fallback 按工具周期切、清旧的可重现工具结果。压缩信号也改按 token 量判断(非消息条数)。

### 变更
- **纠偏者默认开启**:`DAO_REFOCUS_EVERY` 默认 0→**3**(仅长任务下生效),即 `--goal` 长任务每 3 轮自动复核方向、防 scope 蔓延/镀金;显式设 `DAO_REFOCUS_EVERY=0` 可关。
- **挑战者触发完善**:① 失败即算卡(改文件不再赦免"假进展",治"乱改一通错误还在");② 新增"用户重提同一问题"异步触发审视者——免费文本相似度门(`DAO_CHALLENGE_REPEAT_SIM` 默认 0.1,`=0` 关)命中才 fork 挑战者,**不阻塞主流程**、结论回合边界注入,本回合内尽量接住。仅交互式生效。

## [0.1.14] - 2026-06-20

首个公开发布;以下为自 MVP(0.1.2)起的累积变更。

### 新增
- **profile 凭证体系**:多 key / 多 provider 就绪,交互式 `/account` 选择器,`/login`·`/logout` 统一 onboarding。
- **技能体系**:内置核心技能扩到 5 个(simplify / debugging / tdd / planning / code-review),对齐 writing-skills 写作标准;可单个或批量 `/skills` 开关,外来技能首次加载按用途自动转换工具名/模型档并缓存。
- **长任务稳健**:流式→非流式降级、反应式压缩(上下文超限自动压缩重试)、压缩降级阶梯 + 熔断、模型回退、advisor 空转/临近上限提醒、增量压缩、真实 token 触发压缩。
- **错误恢复**:`max_output_tokens` 截断续写补全、`Retry-After` honoring、背景查询 529 不重试(防并行子代理级联)。
- **安全纵深**:危险命令黑名单、敏感目标 bypass-immune、Unicode 消毒、秘密扫描、子进程 env 脱敏、SSRF 防护、目录信任(`dao trust`)、审计日志、可选 OS 沙箱(`DAO_SANDBOX`)与系统钥匙串(`DAO_USE_KEYCHAIN`)。
- **成本**:人民币计费(按模型分价)+ 可选预算提醒;`explore` 子代理与 coordinator 研究阶段走 flash 省成本。
- **能力**:`/goal <目标>` 一键长任务、`verify_done`/DoD 验收、todo 穿越压缩、OS crontab 定时调度、fork 子代理(复用前缀缓存)、MCP 崩溃自动重连、桌面通知 + 防休眠、启动更新检查、Lite-Log 秒列 `/resume`、插件多组件(commands/agents/hooks)、编辑后诊断回灌(`DAO_DIAGNOSTICS`)。

### 变更
- `/task` 改名 `/goal`(`/task` 保留为别名),`/goal <目标>` 直接开跑。
- 模式图标改单色单宽字形(∞/⊙/❖/※/◇/✎)。
- 「其他(自己输入)」选项改为内联输入行(灰色提示 + 聚焦即可打字)。
- 缓存命中骤降埋点 + 归因(`--verbose`)。

### 工程
- 开源准备:SECURITY / CONTRIBUTING / CODE_OF_CONDUCT / CHANGELOG / issue·PR 模板 / ESLint + CI lint / dependabot。

## [0.1.2]
- MVP:Ink TUI、流式 + 工具 + 审批、ESC 打断、三层持久记忆、prompt-cache 感知、技能/插件/MCP 扩展、会话持久化与 `/resume`。
