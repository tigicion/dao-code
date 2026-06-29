# Dao Code 道

**中文** · [English](./README.md)

[![CI](https://github.com/tigicion/dao-code/actions/workflows/ci.yml/badge.svg)](https://github.com/tigicion/dao-code/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](./.nvmrc)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

> **以成本、体验、可用性为核心的终端编码 agent** —— 在高性价比的 DeepSeek V4 上,极致压榨模型的潜能与成本优势。
>
> *A terminal coding agent built around cost, experience, and availability — squeezing the most capability and the lowest cost out of the high-value DeepSeek V4.*

![Dao Code demo](docs/assets/demo.gif)

Dao Code(命令 `dao`)是终端原生的 AI 编码助手:在你的终端里读代码、写代码、跑命令、修 bug,边流式展示推理与工具调用,边在审批门下安全执行,直到任务做完。它面向 **DeepSeek V4**(1M 上下文),中文优先,灵感来自 Claude Code,但走的是另一条路——**不靠贵模型堆体验,而是充分发挥 DeepSeek 的高性价比与极低缓存定价:通过工程化的字节稳定前缀与缓存复用 fork,让跨会话记忆与全程自我纠错几乎不增加 token 开销。**

---

## 为什么是 Dao Code?

### 🌐 可用性

编码 agent 的前提是"用得上"。

- **Claude Code** 依赖 Anthropic 账号与网络,国内开箱即用门槛高;
- **GLM 的 Coding Plan** 名额紧俏、常常抢不到;
- **Dao Code 完全开源(MIT)**,底座 **DeepSeek 注册即用、按量付费、国内直连**——不挑网络、不抢额度、不等邀请。

### 💰 成本

- **单价低** —— DeepSeek 处于主流可用模型的最低价位档,输入/输出单价都远低于第一梯队闭源模型。
- **缓存再砍一截** —— DeepSeek 前缀缓存命中价 ≈ 未命中的约 **1/120**(低约两个数量级)。Dao Code 把系统前缀 / 工具表 / 记忆按【逐字节稳定】铺排,反思与记忆都走复用缓存的 fork,让命中率持续走高。
- **实测(真实开源 bug-fix,非玩具演示)** —— 7 道 SWE-bench 风格任务(valibot / date-fns / es-toolkit / sqlglot / hono),合计 **389 万输入 tok**,**聚合缓存命中 95.8%**(单任务 85.4%–97.7%)。DeepSeek V4 Pro 现价下,**一次完整功能开发(读+改+测+自审)¥0.07–0.21、均 ¥0.15**,7 任务合计 **¥1.07**。每个数都可追溯到 `evals/runs/<task>/run-1/agent.log`,`/cost` 随时复看。
- **对标 Claude Code 的成本** —— 把这 7 个任务的**同一 token 轨迹**按各家官方单价各算一遍(并把 Dao Code 的高命中率一并算给 Claude、对它有利),总成本仍 **比 Claude Opus 4.8 省 ~30×、比 Sonnet 4.6 省 ~18×**。

  | 任务(真实开源 repo) | 输入 tok | 命中率 | DeepSeek Pro | vs Opus | vs Sonnet |
  |---|---:|---:|---:|---:|---:|
  | t7-sqlglot-sqlite-autoinc | 1,218,385 | 97.7% | ¥0.213 | 37× | 22× |
  | t6-sqlglot-comment-on | 625,772 | 96.3% | ¥0.144 | 32× | 19× |
  | t9-hono-compress | 699,479 | 96.0% | ¥0.209 | 31× | 18× |
  | t8-hono-cookie-dup | 502,866 | 94.9% | ¥0.136 | 28× | 17× |
  | t4-estoolkit-omitby | 445,475 | 94.4% | ¥0.159 | 28× | 17× |
  | L1-nodeps-toolkit | 289,989 | 93.2% | ¥0.140 | 27× | 16× |
  | t5-estoolkit-uniqwith | 104,071 | 85.4% | ¥0.068 | 21× | 12× |
  | **合计** | **3,886,037** | **95.8%** | **¥1.07** | **30×** | **18×** |

  <sub>价以 2026-06 官方现价为准:DeepSeek V4 Pro 命中/未命中/输出 = $0.003625 / $0.435 / $0.87 每 1M;Claude Opus 4.8 = $5 / $25(命中按 0.1× cache-read)、Sonnet 4.6 = $3 / $15。倍数为美元同价口径,与汇率无关;¥ 按 ¥7.1/$ 折算。交叉验证:L1 现价重算 ¥0.140 ≈ 日志内 `/cost` 自带的 ¥0.136。</sub>
- **缓存机制可现场验证** —— `npm run accept:cache` 用一段多轮对话现网跑一遍,看命中率随轮次从冷启动爬到稳态(机制演示;成本以上面真实评测为准)。

### 🧠 体验

- **可信的记忆 + 反思层** —— 跨会话记住你的偏好与项目约定,且**每次启动按当前代码确定性校验**:过期的剔除、变了的标注,而非盲目堆历史(别家记得住,但会记错)。卡住时自我审视、跑偏时拉回方向。三者都以**复用主前缀缓存的 fork 子代理**实现——提质,却几乎不额外烧钱。
- **长任务不跑偏、不撞墙** —— 接近上下文上限自动压缩穿越、每 N 轮周期性纠偏防 scope 蔓延,自主跑很久也稳得住。
- **宪法式优先级** —— 安全与真实 > 你当前的指令 > Dao Code 核心策略(模型 / 缓存纪律)> 技能 / 记忆。装来的第三方技能能改"做事流程",但改不动安全与缓存底线。

### ✅ 已被验证

真实开源近期 bug-fix 评测(SWE-bench 风格,fail2pass + pass2pass 双轨判定,测试文件对 agent 隐藏以防 reward-hacking):**稳定解决 13/14**。详见 [测试与评测](#-测试与评测)。

---

## ✨ 特性

### 🗜️ 上下文 & 缓存工程

系统前缀**字节稳定**吃满 DeepSeek 前缀缓存;反思与记忆走**复用主缓存的 fork**(不破前缀);接近上限自动压缩(反应式重试 + 旧工具结果就地清理 + 增量摘要 + 摘要失败硬截断兜底),超大输出落盘、上下文只留指针。`/cost` 看命中率与花费,`/audit cache` 用四维指纹定位"谁破了缓存"。

### 🧠 跨会话记忆(会自我校验)

会话结束自动蒸馏你的偏好、项目约定与关键事实;**启动时按当前代码确定性校验**——过期的剔除、变了的标注,而非盲目堆历史。衰减 GC 清死记忆,模型可 `memory_read` 按需检索。

### 🔍 反思层(卡住/跑偏自我纠正)

**挑战者**:连续失败或同错复发时,派独立视角怀疑性复核、质疑前提;**纠偏者**:长任务每 N 轮复述最初目标、揪 scope 蔓延;**reply-challenger**:你重提同一问题时自动介入。三者都跑复用缓存的 fork,几乎不额外烧钱。

### 🪢 长任务稳健

会话日志 + 崩溃恢复(`dao -c`);**影子 git 检查点**(`/restore` `/rewind`,独立快照、不碰你的 `.git`);todo 穿越压缩防目标漂移;DoD 验收(`/dod` + `verify_done`);卡死检测止损;并行 / 后台 / worktree 隔离子代理 + 子↔父双向通信;`--goal` 长任务自主模式。

### 🎐 道家美学的终端体验

Ink 富渲染 + 太极开屏 + 亮暗自适应;`@` 引文件、slash Tab 补全、**steering(回合运行中打字排队)**、带行号+语法高亮的 diff、思考块、todo 复选框、道家动词 spinner;**ESC 一键打断**(模型流与 shell 一并停);非 TTY 自动回退纯文本 REPL。

> **基本功(对标 CC,均已落地)**:24 个工具 · `allow/ask/deny` 分层权限 + `auto` 智能审批 + 安全纵深(密钥扫描/SSRF/沙箱/钥匙串)· Skills(含**外来技能自动适配**工具名与模型档)· MCP(stdio + HTTP/SSE,tools/resources/prompts)· Hooks(5 生命周期事件)· 自定义子代理 / slash 命令 / 插件 · profile 多账户(`/account`)· OS 定时调度(`/schedule`)。详见 [扩展系统](#-扩展系统)与下方工具一览。

---

## 📦 安装

**A. 一键安装(无需 Node):**

```bash
curl -fsSL https://raw.githubusercontent.com/tigicion/dao-code/master/install.sh | sh
```

或手动到 [Releases](../../releases) 下载:macOS `dao-darwin-arm64`(Apple 芯)/`dao-darwin-x64`(Intel)、Linux `dao-linux-arm64`/`dao-linux-x64`、Windows `dao-windows-x64.exe`。Unix 下 `chmod +x` 后运行;Windows 直接双击 `.exe`。

**B. npm(需 Node ≥ 20,全平台):**

```bash
npx dao-code        # 零安装试用
npm i -g dao-code   # 全局安装,命令名 dao
```

**C. 从源码:**

```bash
git clone https://github.com/tigicion/dao-code.git && cd dao-code
npm install && npm run build && npm link   # 之后可全局 dao
# 或开发直跑:npm run dev
```

---

## 🚀 快速开始

1. 拿一个 DeepSeek API key:<https://platform.deepseek.com/api_keys>

2. **启动 → 跟着引导填 key:**

   ```bash
   dao                # 已安装(二进制/全局);或 npx dao-code
   ```

   首次在终端运行且没检测到 key 时,会引导你粘贴,并存到 `~/.dao/config.json`(下次自动读,无需再配)。

3. 或手动设 key(任选一种,按你的系统):

   | 方式 | 命令 |
   |---|---|
   | `.env`(项目根,全平台) | 写一行 `DEEPSEEK_API_KEY=sk-...` |
   | macOS / Linux | `export DEEPSEEK_API_KEY=sk-...` |
   | Windows PowerShell | `$env:DEEPSEEK_API_KEY="sk-..."` |
   | Windows CMD | `set DEEPSEEK_API_KEY=sk-...` |

4. 浅色终端:运行中输入 `/theme` 切换,或启动前设 `DAO_THEME=light`。

常用斜杠命令(完整列表见 `/help`):

| 命令 | 作用 |
|---|---|
| `/init` | 扫描本仓库生成 `DAO.md`(项目概览/约定,供以后会话自动加载) |
| `/model [id]` | 切换模型(不带参数在 `deepseek-v4-pro` / `deepseek-v4-flash` 间切换) |
| `/mode [x]` | 权限模式 `default` / `acceptEdits` / `auto`(智能审批)/ `plan`(亦 **Shift+Tab** 循环) |
| `/plan` | 快捷切换 plan(只读+提方案)/ normal |
| `/goal <目标>` | 长任务自主模式(自动批准 + 连续推进,大任务自动分阶段) |
| `/cost` | 查看 token 用量与缓存命中率 |
| `/skills` | 列出 / 开关技能 |
| `/compact` | 手动压缩对话 · `/clear` 清空 · `/help` 命令列表 · `/exit`(亦 `/quit`)退出 |

> 启动时加 `--yolo`(如 `dao --yolo` / `dao --yolo "任务"`)可一开始就进入自动批准;运行中用 `/yolo` 随时开关。
> `dao --verbose`(或 `--debug`)**启动**即进入详尽模式:工具结果全量、思考全量、并展示工具的原样参数。
> 普通 `dao` 启动时默认截断,运行中按 **Ctrl+O** 展开/收起全量(对标 CC);已打印进滚动区的历史无法原地改,故展开时会把最近一条折叠内容补充显示一次。

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
- **并行 / 后台子代理 + 通知队列**:`agent` 传 `tasks[]` 并行,或 `background:true` 后台跑(立即返回、不阻塞主循环);完成后结果作为 `<task-notification>` 自动注入续跑(`src/agent/tasks.ts`)。
- **按需记忆检索**:`memory_read` 让模型主动检索跨会话记忆(启动只注入 top-K,被截断/刚写的也查得到)。
- **长任务自主模式**:`dao --goal`(旧名 `--task` / `--coordinator` 仍兼容)或运行时 `/goal <目标>` —— 自动批准 + 自主连续推进 + 更高轮数;大任务自动分阶段编排(研究并行 → 综合 → 实现 → `verify_done` 验收),仅真卡住才问你。

---

## 🧩 扩展系统

- **权限控制**:规则三态 `allow / ask / deny`,语法 `Tool(specifier)`——`Bash(npm run test:*)`(命令前缀)、`Edit(src/**)`/`Read(//etc/**)`(gitignore 式路径 glob)、`WebFetch(domain:example.com)`、裸工具名、`mcp__server__tool`。优先级 **deny > ask > allow > 模式/能力默认**(deny 是硬黑名单,YOLO 下也拦)。
  - **分层**(低→高优先级):`~/.dao/settings.json`(用户)< `.dao/settings.json`(项目,入库)< `.dao/settings.local.json`(本地,不入库)< **CLI**(`--allow`/`--deny`/`--add-dir`/`--permission-mode`)< **企业托管策略**(`/etc/dao/managed-settings.json` 等,不可被下层覆盖)。
  - **复合命令逐段检查**:`cd /tmp && rm -rf x` 会按 `&&`/`||`/`;`/`|` 拆开,任一子命令命中 deny 即整条拦截(杜绝绕过)。
  - **权限模式**(`/mode <x>` 或 **Shift+Tab** 循环;状态栏显示):`default`(按需审批)/ `acceptEdits`(自动批准文件编辑)/ `auto`(AI 分类器智能审批:只读与工作区内编辑自动放行、拿不准转人工)/ `plan`(只读规划);`bypassPermissions`(=YOLO)仅 `dao --yolo` 启动时开。
  - **审批四档**:`[y]` 本次 / `[s]` 本会话 / `[a]` 记住(写 allow 规则到 `.dao/settings.local.json`)/ `[n]` 拒绝。
  - `additionalDirectories`:预授权的工作区外目录,读取不弹窗。
  - 引擎:`src/permissions/`(rules / identity / settings / engine / gate),含端到端测试。
- **自定义子代理类型**:`.dao/agents/<name>.md`(frontmatter:name/description/tools 白名单/model + 正文 prompt)。`agent` 工具 `agent_type` 指定;各有专属角色与工具。
- **自定义 slash 命令**:`.dao/commands/<name>.md`(正文为 prompt 模板,`$ARGUMENTS`/`$1`)。`/<name> 参数` 展开成一个回合跑。
- **Skill(开箱即用技能)**:`.dao/skills/<name>/SKILL.md`。渐进式披露:启动只列 name+description,模型用 `skill` 工具按需加载正文。
- **Hooks(生命周期钩子)**:`.dao/hooks.json`。PreToolUse(可阻断)/PostToolUse(如自动格式化)/UserPromptSubmit(注入上下文/阻断)/SessionStart/End。
- **MCP**:`.dao/mcp.json`。连 stdio MCP server,工具自动注册为 `mcp__<server>__<tool>`。
- **子代理编排**:并行 `tasks[]`、`background:true` 异步后台、`isolate:true` git worktree 隔离、`task_send` 给运行中任务追加指令、前台超时自动转后台、转录落盘 `.dao/subagents/`。
- **steering**:回合运行中也能打字,回车排队,当前回合结束后自动处理。

> 兼容 Claude Code:`settings.json`、`SKILL.md`、`hooks.json`、`mcp.json` 与 CC 同款格式(工具名自动映射 `Bash↔exec_shell` 等),现成的 CC 配置/技能可直接拿来用。

## 🛠️ 工具一览

注册表见 `src/index.ts`,实现在 `src/tools/`。

| 工具 | 作用 |
|---|---|
| `read_file` | 读文本文件,返回带行号内容(支持 offset/limit) |
| `list_dir` | 列目录条目 |
| `write_file` | 新建或整体重写文件(覆盖前需先读过) |
| `edit_file` / `multi_edit` | 精确字符串替换(单处 / 一次多处) |
| `notebook_edit` | 编辑 Jupyter notebook 单元 |
| `exec_shell`(+`_poll`/`_kill`) | 在工作区执行 shell;支持前台/后台(`background=true`)、读后台输出、终止 |
| `grep_files` / `file_search` | 按内容正则 / 按文件名 glob 搜索 |
| `ask_user` | 向用户提一个澄清问题并等回答 |
| `fetch_url` / `web_search` | 抓网页纯文本 / DuckDuckGo 联网搜索 |
| `todo_write` | 维护单层任务清单(整表替换) |
| `verify_done` | 跑 DoD 验收命令判定任务是否完成 |
| `memory_write` / `memory_read` | 记一条跨会话记忆 / 按需检索记忆 |
| `skill` / `skill_install` | 加载技能正文 / 安装外部技能 |
| `agent` / `task_send` / `message_parent` | 派子代理 / 给运行中子代理追加指令 / 子→父回传 |
| `schedule` | 创建 OS crontab 定时任务 |

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
| `DAO_REFOCUS_EVERY` | 纠偏者:长任务每 N 轮复核方向(`0`=关;仅 `--goal` 长任务生效) | `3` |
| `DAO_FAIL_STREAK` | 挑战者:连续失败达此轮数 → 审视进展(交互式生效) | `3` |
| `DAO_REPEAT_ERR` | 挑战者:同一错误复发达此次数 → 审视进展(交互式生效) | `2` |
| `DAO_CHALLENGE_REPEAT_SIM` | 挑战者:用户重提同一问题的相似度阈值,达到则异步唤起审视者(`0`=关;仅交互式) | `0.1` |
| `DAO_REFLECT` | 设 `0` 全局关闭反思层(挑战者+纠偏者) | 开 |

---

## 🗺️ 状态

已发布 **v0.3.0**(npm `dao-code` + Releases 多平台二进制)。核心完整:Ink TUI 与太极欢迎屏、流式 agent 循环、24 工具、分层权限、持久记忆、缓存工程、反思层、长任务稳健、Skills/MCP/Hooks/子代理扩展、真实 OSS 评测 harness。持续迭代中,欢迎 issue/PR。

---

## 🎨 用 Dao Code 打造

这些开源项目完全用 Dao Code 开发:

- **[redis-rs](https://github.com/tigicion/redis-rs)** —— Rust 写的 Redis 兼容服务器(RESP2、~80 命令),在 `dao --goal` 长任务自主模式下从零完成。
- **[magic-canvas](https://github.com/tigicion/magic-canvas)** —— 幼儿 iPad 涂鸦 App(彩虹线 + 贴纸,SwiftUI + SpriteKit)。
- **[bubble-machine](https://github.com/tigicion/bubble-machine)** —— 幼儿 iPad 吹泡泡 App(长按吹大 / 按住连发,程序化音效)。

---

## 🤝 参与贡献

欢迎 issue 与 PR!上手、脚本、提交规范见 [CONTRIBUTING.md](./CONTRIBUTING.md);社区准则见 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。
**安全漏洞请勿走公开 issue**,按 [SECURITY.md](./SECURITY.md) 私密上报。变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

---

## 📄 License

MIT © tigicion
