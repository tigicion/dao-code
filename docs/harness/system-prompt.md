# 系统提示词(System Prompt)

> 最后核对:2026-07-07,commit `33df233`

## 一句话定位

`src/prompt/system_prompt.ts` 产出一份 zh/en 双语平行模板 + 6 个运行时占位符,最终由 `src/index.ts` 拼上"可用子代理类型"表和"可用 skill"目录,组成发给模型的第一条 system 消息。

## 组装流程

- `buildSystemPrompt(opts)`(`system_prompt.ts:671-684`):按 `opts.lang` 选中文 `BODY`(3-309 行)或英文 `BODY_EN`(312-615 行)模板,对模板做 `replaceAll` 占位符替换,返回纯字符串。
- 真正的最终拼装在 `src/index.ts:631-640`:

  ```
  systemPrompt = buildSystemPrompt({...}) + agentTypesSection + skillsSection
  ```

- `LONG_TASK_DIRECTIVE` / `LONG_TASK_DIRECTIVE_EN`(`system_prompt.ts:633-669`,长任务自主模式指令)是独立导出、**不进入** `buildSystemPrompt`,由调用侧按需作为尾部 system 消息追加,避免污染固定前缀。

## 占位符与数据来源

BODY 内 6 个占位符,全部在 `system_prompt.ts:678-683` 处替换:

| 占位符 | 来源 | 说明 |
|---|---|---|
| `{model_id}` | `opts.modelId` ← `index.ts:633` 的 `cfg.model` | 启动定一次 |
| `{project_instruction_files}` | `opts.projectInstructions` ← `loadProjectInstructions(workspaceRoot)`(`src/project_doc.ts`) | `~/.dao/DAO.md` + 项目链上各级 `DAO.md`/`AGENTS.md`/`CLAUDE.md`/`DAO.local.md` 去重后全文内联 |
| `{tools}` | `opts.toolSummaries` ← `registry.toApiTools()`(`index.ts:454-457`) | 全量工具列表(name+description),与实际按 mode 过滤后发给模型的 tools 数组是两回事 |
| `{cwd}` | `opts.cwd` ← `workspaceRoot` | 启动定一次 |
| `{platform}` | `opts.platform` ← `process.platform` | 启动定一次 |
| `{memory}` | `opts.memories` ← `buildMemorySection(...)`(`index.ts:522`) | 项目/用户/知识库三层记忆经验证、筛选后的文本 |

其余全是静态提示词文本。

## i18n:整篇切换,不是逐句翻译

`opts.lang`(`Lang = "zh"|"en"`,来自 `src/i18n/i18n.ts`)决定用 `BODY` 还是 `BODY_EN` 两个**独立维护的平行模板**(内容基本一一对应),以及占位符缺省文案。语言由 `resolveLang()`(`i18n.ts:21-27`)在启动时按 `DAO_LANG` > 用户设置 > 系统 locale **一次性确定**。

"跟随用户当前消息语言回复"不是靠动态换模板,而是模板里有一段静态的「语言」段落(zh 第 225-241 行 / en 第 530-546 行),指导模型运行时按用户最新消息语言自行判断回复语言。

## Mode(normal/plan)不改 prompt 文本

模板里只有一段静态的「模式」说明(zh 第 254-261 行 / en 第 559-566 行),描述两种模式含义,**文本本身不随 mode 变化**。真正的行为差异在工具层:`src/tools/tools_for_mode.ts` 的 `apiToolsForMode()` 按 `capability !== "write" && capability !== "exec"` 过滤,只影响实际发给模型 API 的 `tools` 参数。

## 子代理场景的 prompt 差异

`src/agent/subagent.ts` 本身不构造 prompt,只接收 `deps.systemPrompt`。差异化逻辑在 `src/index.ts:846-849`:

- 普通子代理:父代理完整 `systemPrompt` **原样保留** + 追加 `"\n\n# 你的专用角色(${def.name})\n${def.prompt}"`(角色文本取自 `bundled_agents.ts` 内置定义或 `.dao/agents/*.md` 自定义)。工具集按 `def.tools`/`def.toolsExclude` 裁剪子集。
- fork 子代理(`runForkAgent`,`index.ts:887-900`):完全复用父代理 `systemPrompt` 和已缓存消息前缀,不做任何裁剪。

## 体量与分段

- 文件共 684 行,约 67KB。
- `BODY`(中文,3-309 行)与 `BODY_EN`(312-615 行)各含 20 个 `#` 一级段落,内容一一对应。
- 大致顺序:身份定位 → 系统机制说明 → 权威层级 → 审视/反思提醒 → 真实纪律 → 处理用户请求 → 行动纪律 → 谨慎执行操作 → 工程克制 → 验证纪律 → 探索深度 → 并行优先 → 模型/上下文选型策略 → 上下文管理 → 语言 → 回复风格 → 模式 → 任务规划 → 环境 → 工具 → 记忆(最后一段)。

## Prefix cache 顺序稳定性

`system_prompt.ts:627-631` 有明确注释:

> 缓存纪律(prefix cache 的 #1 静默杀手):系统 prompt 进固定前缀,必须字节稳定。绝不要往这里插入易变 token——当前时间/日期、session-id、随机问候、每轮变化的状态……占位符里:`{memory}` 放在 BODY 末尾(最易变的放最后,变了只失效尾部);`{model_id}/{cwd}/{platform}/{tools}` 启动时定一次、整会话固定。

配套设计:`index.ts:513-521` 记忆分层注入"整会话固定,不刷新、不破前缀缓存";`LONG_TASK_DIRECTIVE` 单独设计为尾部追加,不进前缀。
