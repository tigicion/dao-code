# 更新日志 / Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.4.14] - 2026-07-21

### 新增
- **百度千帆 Token Plan provider(`qianfan`)**:OpenAI 兼容直连 `https://qianfan.baidubce.com/v2/tokenplan/personal`,模型沿用 `deepseek-v4-pro`/`deepseek-v4-flash`(与官方一致),协议层零改动;校验探针复用火山同款最小 `chat/completions` 探针(该路径同样无 `/models`,已用真实 key 实测确认 404)。另支持该 Token Plan 的 `glm-5.2`(千帆专属,kimi-k2.6/ernie-5.1 仍不支持)。
- **`/model` 按 provider 校验 + 循环**:新增 `MODELS_BY_PROVIDER` 注册表,`/model`(无参)在当前 provider 已知模型间循环(deepseek/火山两档 pro/flash;千帆多一档 glm-5.2),`/model <name>` 对不在该 provider 列表里的模型给出可选项提示,不再是无校验自由文本。
- **`/account` 加账户支持选择 provider**:此前新建账户会静默硬编码 `deepseek`,无法通过 UI 添加第二个火山/千帆账户;现在粘贴 key 后会问一句 provider(回车默认 deepseek)。
- **限流时菜单直接切换账号**:交互场景触发限流(429)时,选择菜单动态列出除当前账号外的全部账号,选中即可切换并立即用新账号重试同一请求,不用中止本轮再手动跑 `/account`。切换是持久的(等同手动切换),不是仅本轮临时借用。
- **`enter_worktree`/`exit_worktree` 工具**:仅在用户明确要求时,把文件读写/`exec_shell`/`verify_done` 的路径解析根切到一个新建的 git worktree,项目身份(memory/MCP/LSP/skills/settings)不受影响,仍指向原项目。
- **`monitor` 工具**:起一个后台监控,把命令的 stdout 按行(200ms 内的多行合并)实时推送成通知,不用像 `exec_shell_poll` 那样反复主动轮询。
- **`task_output` 工具**:增量读取一个后台子代理任务自上次查询以来新产生的中间消息,运行中就能看进度,不用等 `task_get` 给最终结果。
- **运行中排队输入(steering)改为回合内直接注入**:敲回车排队的补充输入现在会在当前回合的下一个工具轮边界直接注入,不用等整个回合跑完才当新一轮处理;ESC 支持两段式——排队未消费时先只取消排队,再按一次才真正中断当前回合;中断回填输入框后按 ↓ 可一键清空,不用逐字删除。
- **后台 shell 完成自动通知**:`process_manager` 新增通知队列 + `onChange` 回调,进程退出时自动把结果回灌给模型,不再需要模型手动轮询 `BashOutput`;`Bash` 工具描述同步说明超时上限(600000ms),`sleep` 拦截阈值从 ≥5s 降到 ≥2s(与 Claude Code 对齐)。

### 变更
- **延迟加载工具改为完全隐藏,不再发占位空 schema**:此前未激活的延迟工具(`monitor`/`cron_*`/`task_*` 等)仍会以"占位空 parameters"的形式出现在发给模型的可调用工具列表里,模型容易没读系统提示就直接按空 schema 传 `{}` 硬调,触发 schema 校验失败后才被动引导去 `ToolSearch`(真实撞见过 `TaskGet`/`CronCreate` 被这样连续误调好几次)。现在改为未激活的延迟工具整条不出现在工具列表里,必须先 `ToolSearch` 激活才可见可调;原有的报错兜底文案保留作为第二道防线。
- **账户切换/新增全字段同步**:`/account` 切换或新增账户后,除已有的 `baseUrl`/`apiKey` 外,`provider` 与实际发请求用的 `session.model` 现在也会同步更新(此前遗漏,靠"各 provider 模型串巧合相同"才未暴露);反思节奏判定改读实时 `provider`,不再用启动时的快照。
- **`/logout` 文案修正**:准确描述"删除整个账户(provider/baseUrl/model/key 一起删)",不再暗示"只清了 key"。
- **工具体系对齐 Claude Code**:`grep_files`/`todo_write`/`exec_shell`/`skill`/`ask_user` 参数补齐;低频工具(`notebook_edit`/`cron_*`/`task_*`/`lsp`/`config`/`plan_mode`/`enter_worktree`/`exit_worktree`/`monitor` 等)改为延迟加载,需 `tool_search` 激活后才发完整 schema;工具名统一改为 PascalCase 命名风格(如 `Grep`/`Glob`/`Bash`)。
- **进度提醒机制默认关闭**:连续多轮无实质推进时追加的静态提醒(`noProgress` 计数器驱动),此前无条件生效,现在需要显式传 `--progress-advice` 才开启——这是和 `--reflect-challenger`(挑战者/纠偏者 LLM fork)完全独立的另一套机制。
- **移除 `verify_done` 工具**:收尾验证统一改为派 `verify` 子代理独立验证,非琐碎改动(3+ 文件编辑、后端/API 改动、基础设施变更)强制要求。

## [0.4.12] - 2026-07-20

### 变更
- **auto 模式下解释器类 Bash 命令(python/node/bash/ssh/eval 等)统一走分类器**:即便用户配了对应的 allow 规则,auto 模式也会将其降级为 ask、交分类器判断,不能靠一条 allow 规则绕过(`dangerous_patterns.ts`)——防止用规则悄悄放开任意代码执行。
- **权限 deny 规则明确为不可协商**:系统提示与拒绝文案同步说明——deny 是硬拦截,用户同意也无法覆盖,遇到不应重试或反问用户能否执行,只能由用户自己改 `.dao/settings.json`。
- **Edit/MultiEdit 的 old_string 未找到时新增标点误配诊断**:精确匹配失败后,会用"形近字符"(全角/半角标点、直弯引号、连字符家族 - vs — vs –、不换行空格等)归一化再匹配一次,命中则在报错里直接指出第几个字符、两边分别是什么(含 Unicode 码点),而不是只说"未找到"让人瞎猜——这类误配此前会让模型放弃 Edit 转去写更能容忍偏差的脚本,反而绕开了权限审批的快速路径。

## [0.4.11] - 2026-07-19

### 变更
- **子代理前台/后台改按依赖关系判断,不是耗时**:去掉"前台子代理跑超过 60 秒自动转后台"的隐藏计时器——参考 Claude Code 的模型,前台/后台是派发时的显式声明(`Agent` 工具的 `background` 参数),不该被任何运行期事件静默覆盖。工具描述(中英文)相应改写:判断标准是"下一步是否依赖这个结果",不是"跑多久"。真要打断一个跑太久的前台调用,用户自己 ESC(已验证能正确中止还在跑的前台子代理)。

## [0.4.10] - 2026-07-19

### 新增
- **状态栏显示后台 shell 数量**:`Bash` 工具 `background=true` 启动的后台进程存在时,状态栏显示 `⎈ N shell(s)`(金色),2 秒轮询刷新——后台 shell 的启停不触发任何事件,只能主动轮询;进程退出后自动消失。
- **`--eval` CLI 评测隔离开关**:等价于同时 `--no-memory --no-skills --no-mcp --no-hooks --no-project-instructions`,每个子开关也可单独使用;`--no-skills` 一并隔离自定义子代理定义(`.dao/agents`)和自定义 slash 命令(`.dao/commands`)。用于评测场景隔离本机个性化配置,避免结果混入不该有的记忆/技能/钩子影响。`terminal-bench` 适配器已接入。
- **`perm-trace.jsonl` 区分分类器自动放行 vs 真人审批**:`auto` 模式下此前"LLM 分类器自动放行"和"真弹窗问了人"合并记成同一个 `source:"ask"`,没法回答"到底打扰了几次人"。现在拆成 `classifier`/`human` 两种来源。

### 修复
- **反 sleep 拦截堵不住复合命令**:原正则只匹配纯 `sleep N`,`sleep N && 其他命令` 这类复合命令能绕过拦截——真实撞见一次 session 里模型连续用 `sleep 45`/`60`/`270` 等复合命令阻塞会话合计 6+ 分钟。改成匹配"以 sleep 开头的复合命令"前缀。
- **`Bash` 工具拦截 `python3 -c` 分析小文件的反模式**:一次性文本/日志分析动不动就现写 `python3 -c` 内联脚本,而不是用 `Grep`/`Read`——真实撞见一次调查任务里连续 10 次 `python3 -c`,涉及文件全部 <20KB,没有一次真需要脚本。命令里能提取出一个存在且不大(≤200KB)的文件路径时第一次就拦;提取不到路径时退回"连续 3 次"兜底提醒。

## [0.4.1] - 2026-07-08

### 新增
- **一次性调用(headless `-p`/eval)trace 落盘**:此前是交互式/非交互管道/一次性三种运行模式里唯一没有完整结构化 trace 的一条,现在跟另外两种一样落盘 `state.json` + `cache`/`tool`/`perm`/`memory`/`skill` 各审计 jsonl。同时把 `reasoning_content` 从"只推流给 UI 显示"改为累积落盘(`reasoningContent` 字段),但组包发给 API 的请求体里剥掉这个字段——只存档,不重发,不占请求前缀 token。
- **记忆纠错闭环**:回合末反思器新增 `corrections`/`confirmed` 两类输出——被实测推翻的记忆 supersede/revise,被实测证实的续命(`touchMemory`),纠错理由落 `corrected` trace 可复盘。`feedback` 类记忆升级为硬门,缺"为什么/怎么用"直接丢弃不落盘。
- **三作用域记忆合并 pass**:会话启动期后台非阻塞跑一次 `maybeConsolidate`(project/user/knowledge 各自按节流跑),把语义重复的记忆合并为 canonical 条目、旧条目 supersede,`/audit` 记忆报告消费合并事件。
- **i18n 三层双语适配**:系统提示词、工具描述/工具返回文案、TUI 摘要全部走 `t(key)`,和此前只覆盖 onboarding/主循环 UI 的范围打通。
- **skill_install 装完自动加载**:不用重启会话,新装的 skill 立刻追加进当前上下文目录。
- **Laminar 可观测性(`--obs`)**:`streamChat`/`runTurn`/`toolExec` 三层 span 包装,异常事件埋点(`cache_low`/`reflect_fired`/`tool_error`),trace 带 session id 与版本元数据,启动自动读 `.env`(免手动 export key)。关闭态零开销直接透传。
- **记忆效果评测框架**(`evals/memory/`):提取(覆盖率/画像/精确率/质量)与召回(P/R/F1 + 相关性缺口)两条评测轨道,LLM 评审器(rubric + 容错解析 + K 次多数票)+ 脱敏器 + 人工金标锚点,已跑出首轮真实基线。
- **SWE-bench Verified 推理适配器**(`evals/swebench/`):裸跑版(宿主临时目录)+ 容器进驻版(官方 harness 建的精确环境容器里跑,判定阶段直接复用镜像)。
- **terminal-bench 自定义 agent 适配器**(`evals/terminal-bench/`):接进官方 `AbstractInstalledAgent` 接口,容器里装 Node 22 + `npm i -g dao-code`,headless 一次性调用完成任务;API key 走官方 `_env` 注入机制,不落进被录像的 tmux 会话。
- **trace 物化 + 可导航 HTML 摘要**:把 `state.json` 拆成"每条消息一个文件"的可导航目录(仿论文分析轨迹的输入形式),配一份自包含的 `trace.html`(按轮时间线、思维链、工具调用、缓存命中率图表)。SWE-bench 与本地/OSS eval 三条路径都已接线。
- **`docs/harness/`**:系统提示词/工具/中间件/技能/子智能体配置/长期记忆六大组件的当前实现快照(区别于 `docs/architecture`/`docs/design` 的历史设计文档),配一份真实 wire 内容生成脚本(`npm run debug:harness-wire`)。

### 变更
- **⚠️ 破坏性变更:去掉环境变量 API key 支持**——不再读 `DEEPSEEK_API_KEY`/`ARK_API_KEY`/`.env`,统一走 profile(`~/.dao/config.json` + 钥匙串,`/account`/`/login` 管理)或 headless 的 `--api-key <key> --provider <deepseek|volcengine>` CLI 参数。原因:env key 会静默覆盖 profile、且在 `/account` 选择器里不可见,排查困难。
- **记忆提取信号化**:从"按记忆类型分类"改为"按信号源定位",提取排序去保守化并补充示例。
- **反思节奏**:DeepSeek 官方 key 每回合都触发反思;火山引擎(Volcengine)保留原有的自适应节奏(连续无收获自动放慢)。
- **记忆去重**:收敛为精确键匹配(不再用字符相似度),真删除支持;子代理增加自挑战(连续失败/同错复发时就地自省,不额外起 fork)。

### 修复
- 技能选择器/`ask_user` 选项列表过长时加窗口滚动,选中项始终在可见范围内。
- `multi_edit` 补齐 diff 展示 + diff 行着色。
- 审批弹窗(问题/"先讨论一下")ESC 现在会正确打断本回合让位给用户;`auto` 模式下 `web_search`/`fetch_url` 不再弹审批(deny 规则仍覆盖)。
- 记忆合并 pass 从"启动期同步阻塞"改为"后台非阻塞",不再让三天一次的 LLM 合并调用卡住启动。
- 两处评测判据假阴性:L1 原型过严、valibot pass2pass flake。

### 工程
- `evals/` 新增 reflect eval harness + 跨项目记忆泄漏 recall 回归用例。
- TUI 测试消除一处 CI 偶发 timing flake(轮询替代单次 delay 断言)。

## [0.3.0] - 2026-06-29

### 新增
- **火山引擎 Coding Plan provider(`volcengine`)**:OpenAI 兼容直连 `https://ark.cn-beijing.volces.com/api/coding/v3`,模型沿用 `deepseek-v4-pro`/`deepseek-v4-flash`(与官方一致),协议层零改动。新增 `ARK_API_KEY`(+ `ARK_BASE_URL`/`ARK_MODEL`)env 源,优先级 `DEEPSEEK_API_KEY` > `ARK_API_KEY` > 激活 profile;来源始终显式呈现。校验探针按 provider 选(coding 路径无 `/models` → 用最小 `chat/completions` 探针)。
- **中英双语界面(i18n)**:启动按系统 locale 检测语言(`DAO_LANG` > `~/.dao/settings.json` 的 `lang` > 系统 `LC_*`/`LANG`,检测不到默认英文)。覆盖**首启 onboarding / 目录信任 / 凭证报错**以及**主循环 UI**——权限模式、状态栏、运行时提示、`/help` 命令表(49 条)、工具标签与通知、`.codeds→.dao` 迁移提示。两套扁平字典 + `zh/en 键集对称`结构护栏。**模型输出语言不变**(仍跟随用户消息);道家名句/太极保留中文作为品牌。
- **道家 onboarding 重做**:首启从 readline 文本两步改为「欢迎屏即配置」的连续 Ink 流——太极/朱印 banner 下原地走 ① 语言 ② Provider(DeepSeek/火山) ③ 粘贴并校验 key ④ 目录信任,配完输入框激活。交互路径**彻底不创建 readline**(规避 readline/Ink 的 stdin 冲突);非交互/headless 保留文本兜底。

### 变更
- `Provider` 抽象与 `DEFAULTS` 扩入 `volcengine`;凭证校验 `validateCredential` 增 `provider` 参数。
- 主循环 UI 文案统一走 `t(key)`,语言选定即时切;`write_file` 结果详情合成行数,不再回显工具层中文。

### 工程
- 子项目 C/B/A + i18n 主循环全程 TDD + 子代理逐任务两段式 review + 终审;设计/计划文档落 `docs/design/`。
- 已知 follow-up:工具层(`tools/`)结果文案 i18n;C 完整实测 gate(对话/flash/计费)。

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
