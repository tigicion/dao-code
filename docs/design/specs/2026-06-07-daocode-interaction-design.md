# DAO CODE 交互层设计 spec

> 日期:2026-06-07 · 状态:已与用户确认,待写实现 plan
> 关联:`docs/architecture/overview.md`(总设计)、`docs/design/plans/2026-06-06-codeds-m9-tui.md`(M9 现状)

## 0. 背景与目标

产品 **codeds 改名 DAO CODE**(取老子的「道」)。当前交互层是纯 `node:readline` + 手搓 ANSI(line mode),结构性短板:流式/工具运行时无法接收按键,做不了中途打断;无富信息展示;美观受限。

本 spec 目标:把交互层重写到 **Ink(React for CLI)**,做到 **美观、功能完善、交互好用**,并与 Claude Code **视觉差异化**(走道家水墨美学)。优先级:界面美观 > 功能完善 > 交互好用 ≫ 成本。

### 硬约束
- **保留非 TTY 纯文本回退**:eval harness 用管道喂 stdin + `CODEDS_AUTO_APPROVE` 跑;管道/CI/非交互必须照常工作,不起 Ink。
- **跨平台**:Apple Terminal / Linux 各终端 / Windows Terminal 都要能用 → 颜色能力自动分层降级。
- **agent 主循环不重写**:只换视图层。

### 非目标(本期不做)
- 多主题切换(先做一套精调默认主题)。
- 鼠标交互、全屏 alt-buffer 应用。
- Rust/Go 重写(npm 分发,无此必要)。

## 1. 总体架构 —— Ink + 双渲染路径

抽象一个 `Renderer` 接口,两套实现:
- `InkRenderer`:TTY 交互态,Ink/React 组件树。
- `PlainRenderer`:非 TTY,纯文本逐行 writer(等价当前 `tui/render.ts` + `markdown.ts` 行为)。

入口 `src/index.ts` 按 `process.stdout.isTTY && !CODEDS_AUTO_APPROVE` 选择 renderer。agent 主循环(`agent/loop.ts`)与工具执行不感知 renderer 种类,只通过事件/回调交互。

**组件树(InkRenderer):**
```
<App>                      // 持 context:session、theme、capabilities、usage
 ├─ <Welcome>             // 启动一次性横幅(见 §3)
 ├─ <Transcript>         // 历史消息,Ink <Static> 冻结防闪
 ├─ <LiveRegion>         // 当前回合流式:reasoning / content / 工具卡片 / diff
 ├─ <StatusBar>          // 底部 chips(见 §5)
 └─ <Composer>           // 输入编辑器(见 §7)
     └─ <ApprovalPrompt> // 审批时独占按键
```

### 单元边界
- `tui/capabilities.ts`:探测终端能力,纯函数,可单测。
- `tui/theme.ts`:语义调色板 + 分档映射,纯数据 + 取色函数。
- `tui/components/*`:每个组件单一职责,`ink-testing-library` 可独立渲染断言。
- `client/client.ts`:仅加 usage 捕获(见 §8),不耦合 UI。

## 2. 颜色能力分层(跨平台地基)

`tui/capabilities.ts`:
- 输入:`env`(`COLORTERM`、`TERM`、`NO_COLOR`、`FORCE_COLOR`)、`stream.isTTY`。
- 输出:`{ tier: "truecolor" | "ansi256" | "ansi16" | "none", isTTY: boolean, columns: number }`。
- 规则:`COLORTERM=truecolor|24bit` → truecolor;`TERM` 含 `256color` → ansi256;TTY 但无上述 → ansi16;`NO_COLOR` 或非 TTY → none。

`tui/theme.ts`:语义色 → 每档具体值。
| 语义 | 含义 | truecolor | ansi256 近似 | ansi16 |
|---|---|---|---|---|
| `ink` | 主文本/墨 | 默认前景 | 默认 | 默认 |
| `jade` | 青玉,主强调(词标/标题) | `#7FB7A6` 系渐变 | 近似 256 索引 | cyan |
| `vermilion` | 朱砂,印章/警示 | `#C8443C` | 近似 | red |
| `dim` | 次要/箴言/reasoning | 灰 | 灰 | bright black |
| `gold` | 点缀(可选) | `#C9A86A` | 近似 | yellow |

- 渐变:truecolor 用 `gradient-string`;非 truecolor 退化为单色(jade/dim)。
- 一切取色经 theme,组件不写死 ANSI。`none` 档输出无色纯文本。

## 3. 欢迎屏(`<Welcome>`)—— 水墨极简·太极(精修版)

布局元素(居中到 `columns`,充足纵向留白):
1. **太极图**:半块字符(`▀▄▌▐█` + 明暗)手绘,truecolor 下黑白灰过渡;低色档退化为单字符 `☯` 或简化图。
2. **DAO CODE 词标**:考究 figlet 字体(或手调字形),truecolor 做 jade→ink 渐变。
3. **朱砂落款印**:`道` 字外加方框,vermilion。
4. **随机道德经名句**(见 §4)+ 署名「— 老子」,dim。
5. **信息行**:模型 · 思考强度 · 模式 · 记忆条数 · 目录 · 版本。
6. **水墨分隔**:渐隐细线(truecolor 渐变,低档普通细线)。
7. **提示行**:`输入消息 · /help · @文件 · Esc 打断`,dim。

**美观交付方式**:提供 `scripts/preview-welcome.ts`(`npm run preview:welcome`),独立渲染欢迎屏(可传 `--tier` 强制档位)。用户在真终端跑/截图 → 反馈 → 迭代调整,直到满意。**美观以用户在真实终端的目视为准**(终端美观依赖字体/真彩支持,无法在无头环境定稿)。

## 4. 道德经名句库(`data/laozi.json` + `tui/maxim.ts`)

- **下载真实全文**(公有领域:Laozi《道德经》)→ 本地 `data/laozi.json`,结构:`{ chapters: [{ n: 1, text: "..." }, ...] }`(81 章作真相源)。
- **精选名句**:`data/laozi-maxims.json`,`[{ text, chapter }]`,从全文人工筛 ~50–100 句短而点题者(上善若水 / 道法自然 / 千里之行始于足下 / 知人者智自知者明 / 大巧若拙 …)。
- `tui/maxim.ts`:`randomMaxim(): { text, chapter }`,**运行时零联网**,从精选库随机取。可注入随机源以便测试(避免 `Math.random` 直接调用,测试用种子)。
- 下载源:wikisource / 公有领域仓库;入库时人工过一遍质量与错字。

## 5. 运行态布局与状态栏

- `<Transcript>`:已完成消息,放入 `<Static>` 冻结(防每 token 重绘整屏)。
- `<LiveRegion>`:当前回合,reasoning 灰显且**可折叠**(默认折叠为「悟…」状态行,展开看全文);content 走 markdown 渲染;工具调用渲染为 `<ToolCard>`;文件编辑渲染 `<DiffView>`(红/绿)。
- `<StatusBar>`(底部一行 chips,按宽度自适应隐藏低优先 chip):
  - `mode`(normal/plan) · `model`(deepseek-v4-pro) · `↑in ↓out`(本会话累计 token) · `cache 命中%`(prompt cache hit/(hit+miss)) · `ctx N%`(已用/1M 窗口) · `~¥cost`(按单价估算) · `⏱ elapsed`(本回合) · `⎇ branch`(git)。
- 数据源:usage(见 §8)、session、git。

## 6. ESC 中途打断

- Ink `useInput` 在 raw mode 下逐键接收;`Esc`(及 `Ctrl-C` 二次确认退出)。
- **每回合一个 `AbortController`**:`runTurn` 创建,signal 同时传入:
  - `streamChat`:`fetch(url, { signal })`,流 `for await` 在 `signal.aborted` 时停止并清理。
  - `exec_shell` 及子 agent:子进程在 abort 时收 `SIGTERM`。
- 打断后:停止当前流,保留已生成内容,回到 Composer 等待新输入(不退出程序)。
- **stdin 协调**:TTY 下 Ink 接管 stdin(`useInput` 内部管理 raw mode);现有 `index.ts` 的共享 `nextLine()` 行队列**仅保留给 PlainRenderer/非 TTY 路径**。审批/ask_user 在 TTY 下走 Ink 组件(`<ApprovalPrompt>`),非 TTY 下走旧 ask。

## 7. 输入体验(`<Composer>`)

- 多行编辑:光标移动、换行(Shift+Enter 或约定键)、Enter 提交。
- 历史:↑↓ 浏览本会话输入历史(ring),Ctrl-R 反向搜索(可后置)。
- **粘贴**:启用 bracketed paste(`\e[?2004h`),识别 `\e[200~/201~`;大粘贴折叠为 `[粘贴 N 行]` 占位,防误提交与刷屏。
- `/` 命令:输入 `/` 弹模糊补全菜单(fzf 式子序列打分),渲染在输入下方;命令集复用 `commands/commands.ts`。
- `@` 文件:输入 `@` 弹路径补全(走工作区,尊重 `.gitignore`)。
- 单一补全控制器同时服务 `/` 与 `@`,避免两套补全互相打架。

## 8. 客户端前置改动(状态栏数据源)

`client/client.ts` + `client/types.ts`:
- 请求体加 `stream_options: { include_usage: true }`。
- `processPayload` 捕获带 `usage` 的 chunk(此 chunk `choices: []`,当前被丢弃):读取 `prompt_tokens`、`completion_tokens`、`total_tokens`、`prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`。
- 新增 `StreamDelta { kind: "usage"; usage: Usage }` 透出;并把最终 usage 附到返回的 `AssistantMessage`(或经 session 累计)。
- `Usage` 类型新增到 `client/types.ts`。
- **这是 §5 状态栏 token/缓存能显示的前提**,故安排在 P2 早段。

## 9. 测试策略

- 组件:`ink-testing-library` 渲染成字符串断言(欢迎屏、StatusBar、ToolCard、DiffView、Composer、ApprovalPrompt)。
- `capabilities.ts`:不同 env/TTY 组合 → 档位,纯函数单测。
- `theme.ts`:每档取色映射单测;`none` 档输出无 ANSI。
- `maxim.ts`:注入随机源,断言取自精选库。
- `client` usage:mock SSE 含 usage chunk,断言 `kind:"usage"` 透出且字段正确。
- 非 TTY 纯文本路径:由现有 eval harness(管道 + AUTO_APPROVE)兜底覆盖。

## 10. 分期(全景一份 spec,分四期落地)

| 期 | 内容 | 价值 |
|---|---|---|
| **P1** | `capabilities` + `theme` + `Renderer` 抽象 + 非TTY回退 + `<Welcome>` + 道德经库 + `preview-welcome` 脚本 | 视觉爽点 + 地基;改名 DAO CODE |
| **P2** | client usage 捕获 + `<StatusBar>` + `<LiveRegion>`/spinner + `<Transcript>`(Static) | 富信息展示主体 |
| **P3** | ESC 打断 + `AbortController` 串入 streamChat/exec_shell/子 agent | 体验关键 |
| **P4** | `<Composer>`(历史/bracketed paste/`/`补全/`@`补全)+ `<ToolCard>`/`<DiffView>` 富渲染 | 交互完善 |

## 11. 依赖(新增)

- `ink`、`react`(Ink 同款)。
- `gradient-string`(真彩渐变,truecolor 才用)。
- figlet 方案:`figlet` 或预生成词标(择一,P1 定)。
- 已有 `tui/width.ts`(CJK 宽度)继续用;评估是否换 `string-width`。
- 测试:`ink-testing-library`。

## 12. 改名清理(DAO CODE)

- CLI 名/横幅/帮助文案/`package.json` name 等从 codeds → DAO CODE。**命令名 = `dao`**(已定)。
- 配置目录:**保留 `~/.codeds`、`.codeds/` 路径不变**(已定),仅改展示名,避免破坏现有 key/approval 与 eval。
- StatusBar chip 取舍:先按 §5 全列(8 个),P2 出预览后按实际观感再调。
