# DAO CODE — 项目指令

终端原生的 AI 编码代理(命令 `dao`):在终端里读/写代码、跑命令、修 bug,流式展示推理与工具调用,在审批门下安全执行。面向 **DeepSeek V4(1M 上下文)**,**中文优先**,交互对标 Claude Code,美学走道家风(Ink TUI + 太极欢迎屏)。

## 技术栈
- **TypeScript(ESM,`"type":"module"`,Node ≥ 20)**;导入用 `.js` 后缀(NodeNext)。
- **Ink(React for CLI)** 做 TUI;`zod` 定义工具入参;`@modelcontextprotocol/sdk` 接 MCP。
- 发布形态:`bun build --compile` 打成**单文件二进制** `dao`。

## 目录结构(`src/`)
- `index.ts` — 启动/装配总入口(加载配置/记忆/技能/插件/MCP,建工具注册表、权限门、会话,跑 Ink 或 repl)。
- `agent/` — 回合循环(`loop.ts`)、压缩(`compact.ts`,含 microcompact)、回合健康监控(`turn_health.ts`,决定何时叫挑战者/纠偏者)、子代理(`subagent.ts`)+ 异步后台任务队列(`tasks.ts`)、worktree 隔离(`worktree.ts`)、反思层(`reflect_*.ts`)。
- `tools/` — 所有工具(`defineTool({name,description,capability,approval,schema,handler})`);执行器 `execute.ts`(按 capability 并发/串行 + 审批)。还有 `sandbox.ts`(安全沙箱)、`ssrf.ts`(SSRF 防护)、`safe_env.ts`。
- `permissions/` — CC 1:1 权限引擎(`engine.ts` 决策、`rules.ts` `Tool(specifier)` 匹配、`identity.ts` 工具名映射、`settings.ts` 规则来源合并)。
- `prompt/system_prompt.ts` — 系统 prompt(含项目指令插槽 `{project_instruction_files}`)。
- `memory/` — 三层记忆 + 蒸馏(distill)。`skills/`、`plugins.ts` — 技能/插件加载。
- `session/` — 会话持久化(`log.ts`)、影子 git 检查点(`checkpoint.ts`)。
- `tui/app/App.tsx` — Ink 主组件(转录、输入、斜杠命令、审批模态)。`commands/` — 斜杠命令(`builtin.ts` prompt 命令 + `commands.ts` dispatch)。
- `client/` — DeepSeek SSE 客户端。`hooks/`、`mcp/`、`config/`(凭证/密钥/多账户)、`approval/`。

## 常用命令
- `npm run dev` — tsx 直跑源码(开发)。
- `npm test`(`vitest run`)/ `npm run test:watch` — 测试。
- `npm run typecheck` — `tsc --noEmit`。
- `npm run lint` — ESLint 检查。
- `npm run build` — `tsc -p tsconfig.build.json` 编译到 `dist/`。
- **`npm run bundle:install`** — bun 编译 + 装到 `~/.local/bin/dao` + **ad-hoc 重签名**(arm64 必须,否则被 SIGKILL)。改完代码要在新终端验证,跑这个。

## 提交前检查(CI 也跑)
```
npm run typecheck && npm run lint && npm test
```
三项全绿才算。改了行为请带测试(vitest;UI 组件用 `ink-testing-library`)。

## 约定
- **注释与面向用户的输出一律中文**;匹配周围代码的风格/缩进/命名,不擅自重构。非必要不加 emoji。
- 测试**就近放**(`*.test.ts` / `*.test.tsx`),与源码同目录;倾向先写/补测试再改实现。
- 工具:capability ∈ read/write/exec/network/plan;`approval` auto/required。写工具改文件前要求先 read_file;写路径经 `resolveWritePath`(区外写走授权)。
- 提交信息:**Conventional Commits**(`type(scope): 简述`),type 取 feat/fix/refactor/docs/test/chore/perf。AI 辅助的加 `Co-Authored-By: Dao <noreply@dao-code>`。
- ES 模块导入必须加 `.js` 后缀(TS NodeNext 要求)。

## 关键环境变量 / CLI 参数
| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DEEPSEEK_MODEL` | 默认模型 | `deepseek-v4-pro` |
| `--api-key` | headless 模式传 key(交互模式 /login 管理) | — |
| `--provider` | headless 模式指定 provider | — |
| `DAO_MAX_TURNS` | 每轮最大工具回合 | `50` |
| `DAO_THEME` | 终端主题 `light`/`dark` | 自动检测 |
| `DAO_AUTO_APPROVE` | 跳过审批(仅沙箱/评估) | off |
| `DAO_REFLECT` | `0` 全局关闭反思层 | on |

## 坑(踩过的)
- **bun 二进制重签名**:`cp` 后必须 `codesign --force --sign -`(`bundle:install` 已含),否则 arm64 启动即 `zsh: killed`。
- **二进制是否最新**:编译后的二进制里中文字符串 grep 不到;用 `find src -newer ~/.local/bin/dao`(空=最新)判断是否需重装。
- **microcompact 只在 `compactMessages` 内调用**——别做"每回合独立裁剪",否则破坏 DeepSeek 前缀缓存、净亏。
- **`.dao/` 已被忽略**(影子 git/会话/导出),不要纳入版本管理或当作源码改。
- **导入后缀**:TS 文件里 `import` 必须用 `.js` 后缀(如 `import { foo } from './bar.js'`),否则 NodeNext 模块解析失败。
- 长任务轮次默认 150、长任务/Coordinator 500(`DAO_MAX_TURNS` 可覆盖)。
