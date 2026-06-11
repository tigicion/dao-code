# DAO CODE 道

> 道家美学 × DeepSeek V4 的终端编码 agent —— 墨黑·青玉·朱砂,太极开屏,《道德经》为伴。

DAO CODE(命令 `dao`)是一个终端原生的 AI 编码助手:在你的终端里读代码、写代码、跑命令、修 bug,边流式展示推理与工具调用,边在审批门下安全执行,直到任务做完。它面向 **DeepSeek V4**(1M 上下文),中文优先,灵感来自 Claude Code,但在交互与美学上自成一派。

```
        ☯   DAO CODE
   「道可道,非常道。」 — 老子
```

---

## ✨ 特性

- **Ink 富终端 TUI** —— 基于 Ink(React for CLI)的 inline 渲染,保留终端原生滚动与文本选择;太极欢迎屏(程序化阴阳鱼、青玉→墨黑渐变词标、随机《道德经》名句)。对话展示对标 Claude Code:工具结果 `⎿` 子块(Bash/grep 显截断输出)、思考留历史(暗色 ✻ 块)、带行号+上下文+语法高亮的 diff、todo 复选框清单;spinner 用《道德经》《庄子》动词(悟/观/参/游/化…)随机轮换。`--verbose` 展示全量信息与原样参数。
- **流式 + 工具 + 审批** —— 实时流式展示推理与回答,自主调用工具,所有写/执行类操作经过审批门(可记住「本会话总是允许」)。
- **ESC 中途打断** —— 基于 `AbortController`,一键打断进行中的回合(模型流与正在跑的 shell 命令一并优雅停止)。
- **持久记忆** —— 会话结束自动蒸馏原子事实与用户模型,跨 session 留存;启动时按实时代码做确定性验证(过期剔除/变更标注),衰减 GC 清理死记忆。
- **prompt-cache 感知** —— 利用 DeepSeek 前缀缓存,固定系统前缀以提高命中率;`/cost` 实时查看 token 用量与缓存命中率。
- **plan / normal 双模式** —— plan 模式只读 + 提方案,结构性拦截一切写/执行工具;normal 模式正常落地改动。
- **自动压缩** —— 接近上下文上限时自动把早期对话压缩成摘要,保留关键事实/改动/决定/未竟事项。
- **子代理** —— `agent` 工具把独立子任务派给子代理自主跑完,只回最终结果。
- **跨平台亮/暗自适应** —— 据 `DAO_THEME` / `COLORFGBG` 选配色,浅色终端不洗白、深色终端不发灰。
- **非 TTY 回退** —— 管道/CI/eval 下自动退回纯文本 readline REPL,行为一致。

---

## 📦 安装

**A. 独立二进制(无需 Node)** —— 最省事:到 [Releases](../../releases) 下载对应平台的 `dao-*`,`chmod +x` 后直接运行。

**B. npm(需 Node ≥ 20)** —— 发布到 npm 后:

```bash
npx dao-code        # 零安装试用
npm i -g dao-code   # 全局安装,命令名 dao
```

**C. 从源码**(贡献者):

```bash
git clone <repo-url> dao-code && cd dao-code
npm install && npm run build && npm link   # 之后可全局 dao
# 或开发直跑:npm run dev
```

---

## 🚀 快速开始

1. 设置 DeepSeek API key(任选其一):

   ```bash
   export DEEPSEEK_API_KEY=sk-...        # 环境变量
   # 或在项目根写 .env: DEEPSEEK_API_KEY=sk-...
   ```

   首次在真终端运行且未检测到 key 时,会引导你粘贴并可保存到 `~/.dao/config.json`。
   获取 key:<https://platform.deepseek.com/api_keys>

2. 启动:

   ```bash
   dao                # 已安装
   npm run dev        # 从源码(tsx src/index.ts)
   ```

3. 浅色终端建议:

   ```bash
   export DAO_THEME=light
   ```

斜杠命令:

| 命令 | 作用 |
|---|---|
| `/model [id]` | 切换模型(不带参数在 `deepseek-v4-pro` / `deepseek-v4-flash` 间切换) |
| `/plan` | 切换 plan(只读+提方案)/ normal 模式 |
| `/mode [x]` | 切换权限模式 `default`/`acceptEdits`/`plan`/`bypassPermissions`(亦 **Shift+Tab** 循环) |
| `/yolo` | 开/关 YOLO(=bypassPermissions):自动批准所有写/执行操作(deny 规则仍拦截) |
| `/clear` | 清空对话(保留系统设定) |
| `/compact` | 手动压缩对话 |
| `/cost`(亦 `/cache`) | 查看 token 用量与缓存命中率 |
| `/help` | 列出可用命令 |
| `/exit`(亦 `/quit`) | 退出 |

> 启动时加 `--yolo`(如 `dao --yolo` / `dao --yolo "任务"`)可一开始就进入自动批准;运行中用 `/yolo` 随时开关。
> 加 `--verbose`(或 `--debug`)进入详尽模式:工具结果全量、思考全量、并展示工具的原样参数(默认只显意图标签 + 截断结果)。

---

## ⌨️ 用法

**交互模式**(默认):

```bash
dao
```

- 输入消息回车发送;`↑/↓` 翻历史;`Esc` 打断当前回合;`/` 开头走斜杠命令(带补全提示)。
- 行内编辑:`←/→` 移光标、`Ctrl-A/E` 行首尾、`Ctrl-W` 删词、`Backspace/Delete` 按光标删;支持粘贴(不自动提交)。
- `@` 引用文件:输入 `@` + 路径片段,列出匹配文件,`Tab` 补全。
- 写/执行类操作经审批门(`[y]本次 [a]记住(写 allow 规则) [n]拒绝`);也可在 `.dao/settings.json` 用 allow/ask/deny 规则预先放行或拦截(见「扩展系统 · 权限控制」);`/yolo` 或 `--yolo` 全自动批准(deny 仍拦)。

**一次性模式**(把任务作为参数,跑完即退,不蒸馏记忆,适合脚本):

```bash
dao "把 src/utils.ts 里的 formatDate 改成支持时区"
```

---

## 🧠 它怎么工作

```
你 ──▶ Ink TUI ──▶ agent loop ──▶ DeepSeek V4
                      │  streamChat(流式推理+回答)
                      │  ▶ 模型请求工具调用
                      │  ▶ 审批门(写/执行需放行)
                      │  ▶ 执行工具 → 回灌结果
                      └─ 循环直到模型不再请求工具
```

- **agent loop**(`src/agent/loop.ts`):每回合调 `streamChat` 流式拿推理+回答,模型若请求工具就经审批门执行、把结果回灌,循环至完成或达最大轮数;`AbortSignal` 透传给模型流与工具,支持 ESC 中断。
- **模式**:plan 模式下,即便模型请求写/执行工具也会被本轮允许表直接拒绝(只读+提方案);normal 模式正常执行。
- **记忆**(`src/memory/`):启动时迁移→加载→对实时代码确定性验证→注入固定前缀;退出时用便宜的 flash 模型蒸馏新事实,去重后 upsert。
- **缓存与压缩**:系统前缀固定以吃 DeepSeek 前缀缓存;接近 1M 上下文上限时自动压缩早期消息为摘要。

---

## 🪢 长任务稳健性

面向"自主跑很久、不漂移、可恢复、能验收"的长任务:

- **会话日志 + 崩溃恢复**:每回合把事件写 `.dao/sessions/<id>/events.jsonl`、状态快照写 `state.json`;崩溃/异常退出后 `dao -c` 恢复上次会话(`src/session/log.ts`)。
- **影子 git 检查点**:独立 `.dao/shadow.git` 对工作区快照(不碰你的 `.git`/不改你的历史);`/restore` 一键回退上一回合改动(`src/session/checkpoint.ts`)。
- **任务清单穿越压缩**:`todo_write` 维护的清单在压缩后作为 system 消息重注入,防长任务目标漂移。
- **验证驱动完成(DoD)**:`/dod <命令>`(或 `DAO_VERIFY_CMD`)设可执行验收命令,`verify_done` 跑它——通过(exit 0)才算完成;没设则模型据证据自判。
- **卡死检测 + 止损**:重复同一工具调用/反复同一错误达阈值 → 先提醒换思路、再卡则停止,防空转烧预算(`src/agent/stuck.ts`)。
- **超大输出落盘**:工具输出超阈值时全量落 `.dao/spill/`、上下文只留截断+指针,按需 `read_file` 取回。
- **并行子代理**:`agent` 工具传 `tasks[]` 并行派多个独立子代理并汇总。
- **异步后台子代理 + 通知队列**:`agent` 传 `background:true` 后台跑、立即返回、主循环不阻塞;完成后结果作为 `<task-notification>` 自动注入续跑(`src/agent/tasks.ts`)。状态栏显示运行中的后台任务数。
- **按需记忆检索**:`memory_search` 让模型主动检索跨会话记忆(启动只注入 top-K,被截断/刚写的也查得到)。
- **长任务自主模式**:`dao --task` 或 `/task` —— 自动批准 + 自主连续推进 + 更高轮数 + 末尾给总结;仅真卡住才问你。
- **Coordinator 协作编排**:`dao --coordinator` 或 `/coordinator` —— 把较大任务做成多 agent 工作流(研究并行 → 综合 → 实现 → 验证),坐在异步后台子代理 + 通知队列之上:派出研究 worker → 结束本轮 → 结果回灌 → 综合实现 → `verify_done` 验收。

---

## 🧩 扩展系统(对标 Claude Code)

- **权限控制(1:1 复刻 CC)**:规则三态 `allow / ask / deny`,语法 `Tool(specifier)`——`Bash(npm run test:*)`(命令前缀)、`Edit(src/**)`/`Read(//etc/**)`(gitignore 式路径 glob)、`WebFetch(domain:example.com)`、裸工具名、`mcp__server__tool`。优先级 **deny > ask > allow > 模式/能力默认**(deny 是硬黑名单,YOLO 下也拦)。工具名自动映射(exec_shell↔Bash、read_file↔Read、edit_file↔Edit、fetch_url↔WebFetch…),CC 的 settings.json 规则可原样生效。
  - **分层**(低→高优先级):`~/.dao/settings.json`(用户)< `.dao/settings.json`(项目,入库)< `.dao/settings.local.json`(本地,不入库)< **CLI**(`--allow`/`--deny`/`--add-dir`/`--permission-mode`)< **企业托管策略**(`/etc/dao/managed-settings.json` 等,不可被下层覆盖)。
  - **复合命令逐段检查**:`cd /tmp && rm -rf x` 会按 `&&`/`||`/`;`/`|` 拆开,任一子命令命中 deny 即整条拦截(杜绝绕过)。
  - **权限模式**(`/mode <x>` 或 **Shift+Tab** 循环;状态栏显示):`default`(按需审批)/ `acceptEdits`(自动批准文件编辑)/ `plan`(只读规划)/ `bypassPermissions`(=YOLO,跳过审批但 deny 仍拦)。
  - **审批四档**:`[y]` 本次 / `[s]` 本会话 / `[a]` 记住(写 allow 规则到 `.dao/settings.local.json`)/ `[n]` 拒绝。
  - `additionalDirectories`:预授权的工作区外目录,读取不弹窗。
  - 引擎:`src/permissions/`(rules / identity / settings / engine / gate),含端到端测试。
- **自定义子代理类型**:`.dao/agents/<name>.md`(frontmatter:name/description/tools 白名单/model + 正文 prompt)。`agent` 工具 `agent_type` 指定;各有专属角色与工具。
- **自定义 slash 命令**:`.dao/commands/<name>.md`(正文为 prompt 模板,`$ARGUMENTS`/`$1`)。`/<name> 参数` 展开成一个回合跑。
- **Skill(开箱即用技能)**:`.dao/skills/<name>/SKILL.md`。渐进式披露:启动只列 name+description,模型用 `skill` 工具按需加载正文。
- **Hooks(生命周期钩子)**:`.dao/hooks.json`。PreToolUse(可阻断)/PostToolUse(如自动格式化)/UserPromptSubmit(注入上下文/阻断)/SessionStart/End。
- **MCP**:`.dao/mcp.json`(Claude Desktop 同格式)。连 stdio MCP server,工具自动注册为 `mcp__<server>__<tool>`。
- **子代理编排**:并行 `tasks[]`、`background:true` 异步后台、`isolate:true` git worktree 隔离、`task_send` 给运行中任务追加指令、前台超时自动转后台、转录落盘 `.dao/subagents/`。
- **steering**:回合运行中也能打字,回车排队,当前回合结束后自动处理。

## 🛠️ 工具一览

注册表见 `src/index.ts`,实现在 `src/tools/`。

| 工具 | 作用 |
|---|---|
| `read_file` | 读文本文件,返回带行号内容(支持 offset/limit) |
| `list_dir` | 列目录条目 |
| `write_file` | 新建或整体重写文件(覆盖前需先读过) |
| `edit_file` | 精确字符串替换(`old_string` 须唯一,或用 `replace_all`) |
| `exec_shell` | 在工作区执行 shell;支持前台/后台(`background=true`) |
| `exec_shell_poll` | 读后台进程的新输出与状态 |
| `exec_shell_kill` | 终止后台进程(SIGTERM) |
| `grep_files` | 按内容正则搜索(content/files 两种模式) |
| `file_search` | 按文件名 glob 搜索文件 |
| `ask_user` | 向用户提一个澄清问题并等回答 |
| `fetch_url` | 抓网页并返回去标签纯文本 |
| `web_search` | 用 DuckDuckGo 联网搜索 |
| `todo_write` | 维护单层任务清单(整表替换) |
| `memory_write` | 记录一条跨 session 的稳定记忆 |
| `agent` | 把独立子任务派给子代理 |

---

## 🧪 测试与评测

单元测试(Vitest):

```bash
npm test          # 跑一遍
npm run test:watch
npm run typecheck
```

> `npm audit` 的告警均来自 **dev 测试工具链**(vitest / vite / esbuild),不随发布产物(`dist`)分发,不影响 `dao` 运行时;其中的 critical 是 `vitest --ui` 服务器漏洞(本项目不使用)。CI 见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)。

agent 端到端评测在 `evals/`:SWE-bench 风格,取材真实开源近期 bug-fix,**fail2pass / pass2pass 双轨验证**(改完后目标测试由失败转通过,且既有功能测试不被改坏),测试文件对 agent 隐藏、跑完才注入,以防 reward-hacking。

```bash
DEEPSEEK_API_KEY=sk-... node evals/run.mjs            # 默认每题 3 次,看 pass^k 可靠性
DEEPSEEK_API_KEY=sk-... EVAL_RUNS=1 node evals/run.mjs # 冒烟
```

> 评测真实调用模型、产生费用;每题在抛弃式临时目录跑,无人值守时设 `DAO_AUTO_APPROVE=1` 自动放行。详见 [`evals/README.md`](evals/README.md)。

---

## ⚙️ 配置项

| 变量 | 说明 | 默认 |
|---|---|---|
| `DEEPSEEK_API_KEY` | API key(env / `.env` / `~/.dao/config.json` / 首次引导) | — |
| `DEEPSEEK_BASE_URL` | API 端点 | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | 默认模型 | `deepseek-v4-pro` |
| `DAO_THEME` | `light` / `dark` 强制终端背景 | 据 `COLORFGBG` / OSC 11 探测,否则 `dark` |
| `DAO_REASONING_EFFORT` | 思考强度 | `max` |
| `DAO_MAX_TURNS` | 单回合最大工具轮数 | `50` |
| `DAO_AUTO_APPROVE` | 跳过所有审批(**仅限沙箱/eval**) | 关 |

---

## 🗺️ 状态

MVP 已完成:交互式 Ink TUI 与太极欢迎屏、流式 agent 循环、完整工具集、审批门、ESC 打断、持久记忆、prompt-cache 感知、plan/normal 模式、自动压缩、子代理、以及真实 OSS 评测 harness。仍在持续迭代中。

---

## 📄 License

MIT
