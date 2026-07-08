# 技能(Skills)

> 最后核对:2026-07-07,commit `33df233`

## 一句话定位

`src/skills/skills.ts` 实现"渐进式披露"两层结构:启动只把 `name+description+何时用` 压进系统提示词常驻目录(第一层),正文由模型按需通过 `skill` 工具加载(第二层)。

## 数据结构与存放目录(`skills.ts:8-21, 25-68`)

`Skill` 接口字段:`name`、`description`、`whenToUse`(来自 frontmatter `when_to_use`,决定何时触发)、`slug`(调用短名)、`paths`(条件技能 glob,项目需匹配文件才"在场")、`namespace`(插件命名空间)、`modelInvokable`/`userInvocable`(触发开关,对应 frontmatter `disable-model-invocation`/`user-invocable`)、`body`、`dir`、`file`。

三层存放:内置(代码里,见下)、项目级 `.dao/skills/<name>.md` 或 `.dao/skills/<name>/SKILL.md`、用户级 `~/.dao/skills/`,以及插件目录(`installedPlugins[].skillsDir`)。同名时后传入目录覆盖先传入,`file` realpath 去重(`loadSkills`,`skills.ts:124-137`)。

## skills.ts 核心职责

- `parse`:解析 frontmatter + 正文。
- `loadSkills`:从多个目录批量加载并去重合并。
- `findUserInvocableSkill`:按用户手动 `/技能名` 调用做精确匹配。
- `skillCatalogLines`:把技能列表压缩成"name(调用名):description 何时用"的 catalog 行,单条限 220 字,供系统提示词常驻展示——这是渐进式披露的第一层。正文由模型按需通过 `skill` 工具加载(`src/tools/skill.ts`),是第二层。

## 内置技能清单(`bundled.ts:122-179`)

全部 `core: true`、默认开启、可自动触发,内容直接写死在 TS 源码里(不是文件),由 `src/index.ts:569-571` 转成 `Skill` 对象并入常驻列表:

- `simplify` —— 质量清理
- `debug` —— 系统化排查根因
- `make-plan` —— 动手前先出方案
- `verify` —— 声称完成前独立验证
- `code-review` —— 提交前自审正确性
- `deep-research` —— 多来源联网深研
- `fewer-permission-prompts` —— 把常批准操作固化为 allow 规则
- `run-skill-generator` —— 把项目构建/启动方法固化成 `.dao/skills/run-<项目名>/SKILL.md`

## 安装(`install.ts:12-72`)

对应 `dao skill add` 命令。`source` 可以是 git URL(`git clone --depth 1` 到临时目录)或本地路径;递归扫描含 `SKILL.md` 的目录,逐个校验 frontmatter,复制到 `~/.dao/skills`(scope=user)或 `<workspace>/.dao/skills`(scope=project);若安装名与内置 core 技能同名会提示"覆盖内置",建议用 `/skills off` 处理。安装完需重启 dao 生效。

## 外来技能适配(`convert.ts` / `adapt.ts`)

- `adapt.ts` 的 `isForeignSkill`(8-19 行)做无字典的结构性检测——通过是否出现 CamelCase 工具名(Read/Bash 等 Claude Code 风格)、非 dao 的 snake_case 工具名(`apply_patch`/`run_shell_command` 等 Codex/Gemini 风格)、或 `namespace:skill` 跨引用(如 `superpowers:xxx`),判断该 skill 是否为其它 agent 所写。
- `convert.ts` 的 `makeSkillAdapter`(43-60 行)对判定为"外来"的技能,用一次 flash 模型调用按用途把工具名/模型档位/subagent 表述改写成 dao 自己的工具与模型(`deepseek-v4-flash`/`pro`),按内容 hash 缓存到 `~/.dao/skill-adapted/`(同版本只转一次);flash 不可用时退化为原文 + 通用适配提示。
- 本质:把 Claude Code/Codex/Gemini/Cursor 风格 skill 转成 dao-code 可用格式。

## 使用轨迹审计(`skill_audit.ts:5-8, 18-28`)

按"轮"(一条用户消息)记录模型实际用 `skill` 工具加载了哪个技能,落盘到 `<sessionDir>/skill-trace.jsonl`,`DAO_SKILL_AUDIT=0` 可关闭。附带跨会话聚合统计(`summarizeSkillTrace`/`readAllSkillTraces`/`formatSkillReport`)。命名虽叫 audit,但**不做内容安全扫描**,而是加载行为的可观测性追踪。

## 使用频率打分(`usage.ts:8-32`)

对标 Claude Code 的 skill usage tracking。记录每技能 `count`(累计加载次数)+ `lastUsedAt`(最近日期),用"次数 × 7 天半衰期衰减(下限 0.1)"算 `usageScore`,持久化在 `~/.dao/skill-usage.json`。用于发现排序打破并列、常驻列表预算截断时优先展示常用且近期用过的技能。

## 系统提示词呈现(`src/index.ts:614-635`)

启动时把核心内置 + 启用的磁盘/插件技能(且满足 `paths` 条件的)拼成 `skillsSection`,放在系统提示词"可用 skill"小节,措辞非常强制("哪怕 1% 可能相关也必须先用 skill 工具加载再行动"),只列 `modelInvokable !== false` 的条目。

## 开关(toggle)

没有独立的 `toggle.ts` 文件——`toggleBundled` 函数实现在 `bundled.ts:115-120`(`toggle.test.ts` 只是对它的测试,命名独立但被测代码在 `bundled.ts`)。禁用状态持久化在 `~/.dao/skills-disabled.json`(`index.ts:566`),`/skills off|on <name>` 及批量 `/skills <bundled|installed|all> off|on` 命令在 `index.ts:1346-1378` 处理,写入该禁用集,重启后生效。
