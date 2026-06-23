# CC Hook 完整对等设计(分 4 阶段)

**日期**:2026-06-17
**状态**:已批准范围(用户授权全权实现,不再逐步确认),按阶段 spec→plan→实现

## 1. 目标

把 DAO 的 hook 子系统从"CC 的简化子集"提升为 **CC 兼容的 hook 宿主**,使得为 CC/marketplace 写的 hook(superpowers、security-guidance 等)**不改一行即可在 DAO 运行**。

直接动机(已实证,见 `2026-06-16-subsystem-audit-design.md` 的 skill 审计分析):
- superpowers 通过 **SessionStart hook 注入 `using-superpowers` bootstrap**(per-message skill 门 + 指令优先级)使 CC 的 skill 识别准确。
- DAO 的 hook 实现与 CC **五处不兼容**(配置 schema / 输出协议 / SessionStart 不注入 / matcher 语义 / 插件环境变量),导致这套纪律从未抵达模型。
- 顺带获得 CC 用 B 类输出搭的两项 **DAO 当前没有的能力**:`permissionDecision`(可扩展权限"最后一公里")、`updatedInput`(工具入参改写)。

### 现状(已核实)
- `src/hooks/hooks.ts`(81 行):扁平配置 `{matcher, command}`、原始 stdout 当 context、不解析 JSON。
- `src/index.ts:563` SessionStart 结果**丢弃**;`:932` 仅 UserPromptSubmit 注入。
- DAO **已加载插件 hooks**(`index.ts:552` `pluginComp.hookFiles`),但格式不认。
- DAO **有 MCP 客户端**(`src/mcp/mcp.ts`,官方 SDK + stdio),缺 elicitation。
- DAO 有这些 hook 事件依附的子系统:压缩、子代理、权限门、worktree、后台任务、回合循环。

### 用户决定(范围)
- **配置格式纯按 CC,不兼容 DAO 旧扁平格式**(现有 DAO hook 需改写为 CC 格式)。
- **全部 A 类事件 + MCP Elicitation**(给现有 MCP 加);Team 类(TeammateIdle)不做。
- **B 类输出协议全做**:additionalContext / permissionDecision / updatedInput。
- **全 6 种 hook 类型**:command / prompt / agent / http / callback / function。
- `if` / matcher / async / timeout 随 CC 格式一并支持。

## 2. 架构:新 Hook 引擎

`src/hooks/` 重写为引擎(配置→匹配→执行→输出消费),核心数据流:

```
配置(CC 格式)──loadHooks──▶ 规范化 HookSpec[]
                                  │
事件触发 runHooks(event, ctx) ────▶ 选中(matcher + if 预过滤)
                                  │
                          按 type 分派执行(6 种)
                                  │
                          收集输出 ──▶ 解析(JSON / exit code)
                                  │
                  HookOutcome { block?, additionalContext?, permissionDecision?, updatedInput? }
                                  │
        调用点消费:注入上下文 / 裁决权限 / 改写入参 / 阻断
```

### 2.1 配置 schema(CC 嵌套格式)
文件形如(`~/.dao/hooks.json`、项目 `.dao/hooks.json`、插件 `hooks/hooks.json`):
```jsonc
{ "hooks": {
  "SessionStart": [
    { "matcher": "startup|clear|compact",
      "hooks": [ { "type": "command", "command": "...", "if": "...", "async": false, "timeout": 180 } ] }
  ],
  "PreToolUse": [ { "matcher": "write_file|exec_shell", "hooks": [ { "type": "command", "command": "..." } ] } ]
} }
```
- 解外层 `{"hooks": {...}}` 包(插件文件如此;裸 `{event:[...]}` 也接受以兼容简单写法)。
- 规范化为内部 `HookSpec { event, matcher?, if?, type, command?, prompt?, url?, ..., async, timeout }`。
- **去 DAO 旧扁平格式**:`loadHooks` 只认嵌套 `hooks[]` 结构。
- 环境变量:运行插件 hook 时提供 `CLAUDE_PLUGIN_ROOT`(=该插件根目录)、`DAO_PLUGIN_ROOT`(别名)、`CLAUDE_PROJECT_DIR`(=workspaceRoot),保留 `DAO_HOOK_EVENT`/`DAO_TOOL_NAME`。

### 2.2 输出协议(exit code + JSON)
- **exit 0**:stdout 尝试 JSON 解析:
  - `hookSpecificOutput.additionalContext` ‖ 顶层 `additionalContext` ‖ `additional_context` → 注入文本。
  - `hookSpecificOutput.permissionDecision` ∈ allow/ask/deny(PreToolUse 用)。
  - `hookSpecificOutput.updatedInput`(对象,PreToolUse 用)→ 替换工具入参。
  - 非 JSON 的纯 stdout → 对可注入事件当作 `additionalContext`(向后兼容简单 hook)。
- **exit 2**:阻断;stderr 作原因(展示给模型)。
- **其它非 0**:非阻断错误;stderr 仅给用户。
- 多 hook 合成:`permissionDecision` 按 **deny > ask > allow**;`additionalContext` 拼接;`updatedInput` 后者覆盖前者(按序)。

### 2.3 matcher 与 `if`
- **工具类事件**(Pre/PostToolUse、PermissionRequest、PostToolUseFailure):matcher 匹配**工具名**。
- **SessionStart**:matcher 匹配**来源** `startup|resume|clear|compact`(runHooks 传入 source)。
- 其余事件:无 matcher 或匹配相应维度。
- **`if`**:权限规则语法(`Bash(git push *)` 形)匹配工具名+参数,spawn 前预过滤——复用 DAO 现有权限规则匹配器(`src/permissions/`)。

### 2.4 执行类型(6 种,P1 只做 command,P3 补其余)
| type | 执行 | 实现依赖 |
|---|---|---|
| `command` | shell(stdin 收 JSON payload,exit/stdout 返回) | P1(现有 `runOne` 升级) |
| `prompt` | 单轮调模型(flash),hook 输入作 prompt,产出当 additionalContext | P3,复用 streamChat |
| `agent` | 子代理多轮、可调工具,返回结论 | P3,复用 runSubagent |
| `http` | POST JSON 到 url,响应 JSON 当输出 | P3,fetch |
| `callback` / `function` | 进程内 TS 函数 | P3,需新增编程式注册面 `registerHook()` |

## 3. 四个阶段(各自独立可交付 + 测试)

### P1 · Hook 引擎核心 ⭐(关键路径,交付主目标 + B 类优化)
- 重写 `src/hooks/hooks.ts`:CC 嵌套配置解析、`HookSpec` 规范化、matcher(含 SessionStart 来源)、`if` 预过滤、`CLAUDE_PLUGIN_ROOT` 等环境变量、`command` 类型执行、输出协议解析(JSON additionalContext/permissionDecision/updatedInput + exit code)、多 hook 合成。返回 `HookOutcome`。
- `src/index.ts`:**SessionStart 注入**(捕获 outcome.additionalContext → 一次性作 system 消息注入,缓存安全见 §4);UserPromptSubmit/PreToolUse additionalContext 注入;SessionStart 传 source(startup/resume/clear/compact)。
- `src/tools/execute.ts`:PreToolUse 的 `permissionDecision` 接进裁决(在规则之后、作"最后一公里",deny>ask>allow 合成;敏感安全检查 bypass-immune 保留);`updatedInput` 在执行前替换 `tc.function.arguments`。
- **交付**:superpowers 的 using-superpowers bootstrap 注入跑通(skill 纪律修复)、security-guidance 的 SessionStart/UserPromptSubmit/PostToolUse 跑通、permissionDecision/updatedInput 两项新能力可用。
- **破坏性**:现有 DAO 扁平格式 hook 失效,需改写为 CC 格式(hooks 罕用、用户配置,风险低;`/doctor` 或启动给一次性提示)。

### P2 · A 类事件铺开(依赖 P1 引擎)
在 DAO 已有生命周期点 fire 事件并接 outcome:
- **Stop / StopFailure**:主回合模型响应结束前 / API 错误结束(loop.ts 回合收尾;Stop 的 additionalContext 可注入、可用于 ralph-loop 式续跑)。
- **PreCompact / PostCompact**:压缩前后(`runCompaction`)。
- **SubagentStart / SubagentStop**:`runSubagent` 起止。
- **PermissionRequest / PermissionDenied**:权限弹窗/auto 拒绝点(execute.ts)。
- **WorktreeCreate / WorktreeRemove**:`createWorktree`/cleanup。
- **TaskCreated / TaskCompleted**:后台任务管理器。
- **Notification**:通知发出点。
- **PostToolUseFailure**:工具失败(dispatchOne catch)。

### P3 · 其余 5 种 hook 类型(依赖 P1 引擎的 type 分派)
- `prompt`:hooks.ts type 分派加一支,调 flash 单轮(注入 streamChat 依赖),输出当 additionalContext。
- `agent`:复用 `runSubagent`,返回结论。
- `http`:fetch POST。
- `callback`/`function`:新增 `src/hooks/registry.ts` 编程式注册面(进程内函数表),`runHooks` 分派时调用;供 SDK/内部使用。

### P4 · MCP Elicitation(独立子系统,可与 P1 并行)
- `src/mcp/mcp.ts`:给 client 注册 elicitation 处理器(官方 SDK `elicitInput` 能力);server 请求用户输入(-32042)时,经 TUI 向用户提问、回传。
- `Elicitation` / `ElicitationResult` 事件接入 hook 引擎(P1 之后)。
- TUI:复用现有 ask_user/审批的输入组件提示用户。

## 4. 缓存安全(关键约束)
- **SessionStart additionalContext**:**一次性**注入——作为紧随系统提示后的 system 消息,整会话不变 → 进稳定前缀,第一次调用付一次 token,之后全命中。superpowers bootstrap 虽大但只付一次。
- **UserPromptSubmit / PreToolUse / Stop additionalContext**:**追加到 `session.messages` 尾部**(append-only),不动已缓存前缀(DAO 现有 `index.ts:932` 即此模式,实测零破缓存)。
- **铁律**:绝不把**逐轮变化**的内容注入**稳定前缀中段**(discovery 当年之错)。
- 已落地的**缓存审计**(`cache.jsonl` + `/audit cache`)自动检测任何破缓存回归——实现后跑一轮带 superpowers 的会话验证 0 破。

## 5. 测试策略
- **引擎单测**(`hooks.test.ts` 重写):CC 嵌套配置解析、外层 `{"hooks"}` 解包、matcher(工具名 + SessionStart 来源)、`if` 预过滤、输出协议解析(JSON additionalContext/permissionDecision/updatedInput / 非 JSON 回退 / exit 2 阻断)、多 hook 合成(deny>ask>allow、context 拼接)。
- **集成**:用 superpowers 的真实 `hooks.json` + session-start 脚本,断言 SessionStart additionalContext 被注入到 messages;用 security-guidance 配置断言 UserPromptSubmit/PostToolUse 跑通。
- **缓存**:跑一轮注入后断言 `cache.jsonl` 无 `changed:["sys"]` 破缓存(注入进稳定前缀,sys 维稳定)。
- **B 类**:permissionDecision deny/allow/ask 改变裁决;updatedInput 改写 tc.arguments;各类 hook type 分派(P3)。
- **MCP**:elicitation 往返(P4)。
- 每阶段全量 `npm test` + `npm run typecheck` + `npm run lint`(0 error)绿。

## 6. 关键文件改动(分阶段)
| 阶段 | 文件 | 改动 |
|---|---|---|
| P1 | `src/hooks/hooks.ts` + `.test.ts` | 重写为引擎(CC schema/输出协议/command/matcher/if/env/合成) |
| P1 | `src/index.ts` | SessionStart 注入 + 传 source;UserPromptSubmit/PreToolUse additionalContext;接 outcome |
| P1 | `src/tools/execute.ts` | permissionDecision 接裁决;updatedInput 改写入参 |
| P1 | `src/permissions/*` | 暴露规则匹配器供 `if` 复用 |
| P2 | `src/index.ts`/`loop.ts`/`subagent.ts`/`execute.ts`/worktree/task | 各生命周期点 fire 事件 + 接 outcome |
| P3 | `src/hooks/hooks.ts` + `src/hooks/registry.ts`(新) | type 分派 prompt/agent/http/callback/function |
| P4 | `src/mcp/mcp.ts` + TUI | elicitation 处理器 + 用户提问回传;Elicitation 事件 |

## 7. 执行顺序与并行
- **P1 关键路径**先行(P2/P3 依赖其引擎接口)。
- **P4 与 P1 文件不重叠**(`src/mcp` vs `src/hooks`)→ 可并行(worktree 隔离),最后接 Elicitation 事件需 P1 完成。
- P2、P3 在 P1 合并后展开(都改 `hooks.ts`/`index.ts`,彼此有冲突面,顺序做)。
- 每阶段独立 spec(本文档)→ plan → 子代理实现 → 合并 master。
