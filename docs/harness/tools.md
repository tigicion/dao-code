# 工具(Tools)

> 最后核对:2026-07-07,commit `33df233`

## 一句话定位

`src/tools/registry.ts` 是一个保序的工具注册表,每个工具声明 `capability`(能力类别)和 `approval`(建议审批级别,仅供参考),真正的放行决策在 `src/permissions/engine.ts`,与 mode 联动裁剪在 `tools_for_mode.ts`。

## 核心类型(`src/tools/types.ts`)

```ts
Capability = "read" | "write" | "exec" | "network" | "plan"
Approval   = "auto" | "suggest" | "required"

interface Tool {
  name, description, descriptionEn?, schema(zod),
  capability, approval,
  handler(args, ctx) => Promise<string>,
  apiParameters?,       // 供 MCP 工具用原始 JSON Schema 覆盖 zod 转换
  checkPermissions?(argsJson) => "deny" | "ask" | null,  // 只能收紧,不能放宽
}
```

- 每个工具用 `defineTool<S>(def)` 定义,保留 `z.infer<S>` 的精确 handler 参数类型。
- `ToolContext` 是运行时注入的"能力包":`workspaceRoot`、`ask`/`askChoice`、`runSubagent`/`runForkAgent`/`runBackgroundAgent`、`skills`、`memory`、`hooks`(`preToolHook`/`postToolHook`)、`toolAudit` 等——工具通过它访问受控外部能力,不直接碰全局状态。

`registry.ts` 的 `ToolRegistry`:`register` / `get` / `subset`(白名单建子集,给自定义子代理限制工具)/ `subsetExcluding`(排除式)/ `toApiTools`(转 function-calling 描述,zod→JSON Schema 走 `schema.ts`)/ `dispatch`(JSON.parse 入参 → zod `schema.parse` 校验 → 调 handler)。

## capability → approval:声明 vs 实际裁决

`approval` 字段是每个工具**手写声明的静态标签**,不参与实际放行判断,只供 UI/文档参考。真正的运行时裁决在 `src/permissions/engine.ts` 的 `decide`/`decideBase`:

- `sideEffecting = capability ∈ {write, exec, network}`(read/plan 视为非副作用)。
- 裁决优先级:`deny` 规则 > 危险 shell 命令(任何模式强制 `ask`,plan 除外由第 8 层 deny)> `bypassPermissions`(yolo)> 敏感目标(default/auto 都 `ask`)> `ask` 规则 > `allow` 规则 > 只读 shell 命令快速放行 > 模式/能力默认。
- `default` 模式:sideEffecting → ask(需人工审批);否则 allow。
- `auto` 模式:sideEffecting → 白名单/工作区内编辑放行,其余(含敏感目标)交 AI 分类器(安全自动过、拿不准转人工;私钥读取会被分类器 BLOCK);否则 allow。
- `bypassPermissions`(yolo):除 deny 与危险命令外一律 allow。
- `plan` 模式(只读规划,不进 `/mode` 切换):write/exec/network 一律 deny,read/plan 工具 allow。
- 敏感目标(SSH key、`.git`、`/etc`、凭据等):default/auto 一律 `ask`(auto 的 ask 交分类器而非强制人工);yolo 下放行(全信任)。
- `rules.ts` 里的规则表(deny/ask/allow)优先级高于以上默认值,deny 规则任何模式都拦截。
- `auto` 模式下有 `AUTO_ALLOWLIST`(`read_file`/`grep_files`/`file_search`/`list_dir`/`todo_write`/`ask_user`/`memory_read`/`skill`/`verify_done`/`echo`/`web_search`/`fetch_url`)+ 只读 shell 命令识别,免过 AI 分类器直接放行;但敏感目标产生的 ask 不被白名单/只读快速路径绕过。
- `PermissionGate.decide`(`src/permissions/gate.ts`)在 engine 判定之后,再让工具自身的 `checkPermissions` 做"只能收紧"的二次自检。

## `tools_for_mode.ts` 按模式裁剪

`Mode = "normal" | "plan"`,`apiToolsForMode(registry, mode, lang)`:

- `normal`:返回全部工具。
- `plan`:过滤掉 `capability === "write" || capability === "exec"`,只留只读/网络/plan 类。

子代理的工具裁剪不在这个文件,而是通过 `registry.subset`/`subsetExcluding`(按自定义 agent 类型的 `tools: "a,b" | "*, !c"` 白名单/排除式)在 `agent.ts` 派发子代理前完成,见 [subagents.md](subagents.md)。

## 工具清单(内建 24 个,另加动态注册的 MCP 工具)

注册入口:`src/index.ts:433-439`。

**文件读写**
- `read_file` —— 读工作区文本文件(带行号)`src/tools/read_file.ts`
- `write_file` —— 新建/整体重写文件(需先读过)`src/tools/write_file.ts`
- `edit_file` —— 单处精确字符串替换 `src/tools/edit_file.ts`
- `multi_edit` —— 一个文件内多处替换,原子写 `src/tools/multi_edit.ts`
- `notebook_edit` —— 编辑 Jupyter notebook 单元格 `src/tools/notebook_edit.ts`
- `list_dir` —— 列目录条目 `src/tools/list_dir.ts`

**执行**
- `exec_shell` —— 工作区内执行 shell 命令(前台/后台)`src/tools/exec_shell.ts`
- `exec_shell_poll` —— 读后台进程新输出与状态 `src/tools/exec_shell_poll.ts`
- `exec_shell_kill` —— 终止后台进程 `src/tools/exec_shell_kill.ts`

**搜索**
- `grep_files` —— 按正则搜文件内容 `src/tools/grep_files.ts`
- `file_search` —— 按文件名/路径 glob 搜文件 `src/tools/file_search.ts`

**任务规划**
- `todo_write` —— 维护单层任务清单 `src/tools/todo_write.ts`
- `verify_done` —— 判断任务是否真正完成(跑验收命令)`src/tools/verify.ts`
- `schedule` —— 管理本地定时任务(OS crontab)`src/tools/schedule_tool.ts`

**子代理**
- `agent` —— 派发独立子任务给子代理(单个/并行)`src/tools/agent.ts`
- `task_send` —— 给后台子代理追加指令 `src/tools/task_send.ts`
- `message_parent` —— 后台子代理向父代理发中途消息 `src/tools/message_parent.ts`

**记忆**
- `memory_write` —— 记一条跨 session 稳定记忆(用户模型/偏好/反馈/项目事实)`src/tools/memory_write.ts`
- `memory_read` —— 按名字/关键词查跨会话记忆 `src/tools/memory_read.ts`

**网络**
- `fetch_url` —— 抓取网页转纯文本 `src/tools/fetch_url.ts`
- `web_search` —— DuckDuckGo 联网搜索 `src/tools/web_search.ts`

**其他(交互/技能)**
- `ask_user` —— 向用户提澄清问题(支持结构化单/多选)`src/tools/ask_user.ts`
- `skill` —— 加载并执行一个 skill 的完整指令 `src/tools/skill.ts`
- `skill_install` —— 从 git/本地路径安装一套技能 `src/tools/skill_install.ts`

此外 `src/index.ts:448-451` 会连接 MCP servers,把外部 MCP 工具以 `mcp__server__*` 命名动态注册进同一 registry,数量不固定。

**未构成独立 Tool 的基础设施文件**(被上述工具复用,不在工具清单里):`diagnostics.ts`(嗅探 lint/tsc 诊断命令)、`diff_hunk.ts`(生成 diff 展示)、`execute.ts`(工具调用执行器,串起审批门/审计/hooks)、`glob.ts`/`walk.ts`(glob 匹配、目录遍历)、`fs_atomic.ts`/`file_lock.ts`(原子写、按路径串行锁)、`process_manager.ts`(后台进程管理)、`spill.ts`(输出溢出到文件)、`output.ts`(输出截断)、`lang.ts`/`paths.ts`(i18n 文案、路径安全解析)、`todo_store.ts`(`todo_write` 存储层)、`schema.ts`(zod→JSON Schema)。

## 工具审计(`tool_audit.ts`)

`ToolAuditSink`:每次工具调用记录 `{name, cap, ok, durationMs, args摘要}` 落盘到 `<sessionDir>/tool-trace.jsonl`(受 `DAO_AUDIT`/`DAO_TOOL_AUDIT` 开关控制,默认开)。提供 `summarizeToolTrace`(按错误率/调用量聚合)和 `readAllToolTraces`(跨会话读取),`formatToolReport` 生成"调用次数/错误率/耗时"报告——事后诊断用,不参与实时审批决策。

## 安全相关文件

- `sandbox.ts` —— OS 级沙箱:`DAO_SANDBOX=1` 时把 shell 命令包进 macOS Seatbelt / Linux bubblewrap,限制为工作区可写、其余只读,是应用层审批之外的纵深防御。
- `safe_env.ts` —— 子进程环境变量脱敏:spawn 前剥除 `API_KEY`/`SECRET`/`TOKEN` 等敏感环境变量,防止被提示注入诱导泄露凭据。
- `ssrf.ts` —— `fetch_url`/`web_search` 抓取前拦截 localhost/内网/云元数据端点等目标,防止被诱导攻击内部服务。
