# DAO CODE 道

> 道家美学 × DeepSeek V4 的终端编码 agent —— 墨黑·青玉·朱砂,太极开屏,《道德经》为伴。

DAO CODE(命令 `dao`)是一个终端原生的 AI 编码助手:在你的终端里读代码、写代码、跑命令、修 bug,边流式展示推理与工具调用,边在审批门下安全执行,直到任务做完。它面向 **DeepSeek V4**(1M 上下文),中文优先,灵感来自 Claude Code,但在交互与美学上自成一派。

```
        ☯   DAO CODE
   「道可道,非常道。」 — 老子
```

---

## ✨ 特性

- **Ink 富终端 TUI** —— 基于 Ink(React for CLI)的 inline 渲染,保留终端原生滚动与文本选择;太极欢迎屏(程序化阴阳鱼、青玉→墨黑渐变词标、随机《道德经》名句)。
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

需要 **Node >= 20**。

从源码:

```bash
git clone <repo-url> dao-code
cd dao-code
npm install
```

(发布后亦可全局安装,命令名为 `dao`:)

```bash
npm i -g dao-code
```

---

## 🚀 快速开始

1. 设置 DeepSeek API key(任选其一):

   ```bash
   export DEEPSEEK_API_KEY=sk-...        # 环境变量
   # 或在项目根写 .env: DEEPSEEK_API_KEY=sk-...
   ```

   首次在真终端运行且未检测到 key 时,会引导你粘贴并可保存到 `~/.codeds/config.json`。
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
| `/yolo` | 开/关 YOLO:自动批准所有写/执行操作(慎用;状态栏会显示 ⚡YOLO) |
| `/clear` | 清空对话(保留系统设定) |
| `/compact` | 手动压缩对话 |
| `/cost`(亦 `/cache`) | 查看 token 用量与缓存命中率 |
| `/help` | 列出可用命令 |
| `/exit`(亦 `/quit`) | 退出 |

> 启动时加 `--yolo`(如 `dao --yolo` / `dao --yolo "任务"`)可一开始就进入自动批准;运行中用 `/yolo` 随时开关。

---

## ⌨️ 用法

**交互模式**(默认):

```bash
dao
```

- 输入消息回车发送;`↑/↓` 翻历史;`Esc` 打断当前回合;`/` 开头走斜杠命令。

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

agent 端到端评测在 `evals/`:SWE-bench 风格,取材真实开源近期 bug-fix,**fail2pass / pass2pass 双轨验证**(改完后目标测试由失败转通过,且既有功能测试不被改坏),测试文件对 agent 隐藏、跑完才注入,以防 reward-hacking。

```bash
DEEPSEEK_API_KEY=sk-... node evals/run.mjs            # 默认每题 3 次,看 pass^k 可靠性
DEEPSEEK_API_KEY=sk-... EVAL_RUNS=1 node evals/run.mjs # 冒烟
```

> 评测真实调用模型、产生费用;每题在抛弃式临时目录跑,无人值守时设 `CODEDS_AUTO_APPROVE=1` 自动放行。详见 [`evals/README.md`](evals/README.md)。

---

## ⚙️ 配置项

| 变量 | 说明 | 默认 |
|---|---|---|
| `DEEPSEEK_API_KEY` | API key(env / `.env` / `~/.codeds/config.json` / 首次引导) | — |
| `DEEPSEEK_BASE_URL` | API 端点 | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | 默认模型 | `deepseek-v4-pro` |
| `DAO_THEME` | `light` / `dark` 强制终端背景 | 据 `COLORFGBG` / OSC 11 探测,否则 `dark` |
| `CODEDS_REASONING_EFFORT` | 思考强度 | `max` |
| `CODEDS_MAX_TURNS` | 单回合最大工具轮数 | `50` |
| `CODEDS_AUTO_APPROVE` | 跳过所有审批(**仅限沙箱/eval**) | 关 |

---

## 🗺️ 状态

MVP 已完成:交互式 Ink TUI 与太极欢迎屏、流式 agent 循环、完整工具集、审批门、ESC 打断、持久记忆、prompt-cache 感知、plan/normal 模式、自动压缩、子代理、以及真实 OSS 评测 harness。仍在持续迭代中。

---

## 📄 License

MIT
