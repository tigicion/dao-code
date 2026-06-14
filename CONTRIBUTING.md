# 贡献指南 / Contributing

感谢参与 DAO CODE!本文是上手与提 PR 的最短路径。

## 环境
- Node.js **≥ 20**(见 `.nvmrc`)
- 推荐:DeepSeek API key(跑真实交互时需要;跑测试不需要)

## 上手
```bash
git clone https://github.com/tigicion/dao-code.git
cd dao-code
npm ci
```

常用脚本:
| 命令 | 作用 |
|------|------|
| `npm run dev` | tsx 直跑(开发) |
| `npm test` | 跑 vitest 全量测试 |
| `npm run typecheck` | `tsc --noEmit` 类型检查 |
| `npm run lint` | ESLint 检查 |
| `npm run build` | 编译到 `dist/` |
| `npm run bundle:install` | bun 编译单文件二进制并装到 `~/.local/bin/dao` |

## 提交前必过(CI 也会跑)
```bash
npm run typecheck && npm run lint && npm test
```
**三项全绿**才提 PR。改了行为请**带上测试**(vitest;UI 用 `ink-testing-library`)。

## 提交信息规范(Conventional Commits)
格式:`type(scope): 简述`,type 取 `feat / fix / refactor / docs / test / chore / perf`。中英文均可。
若是 AI 辅助完成,提交信息末尾加一行:
```
Co-Authored-By: <Assistant> <noreply@...>
```
示例:`fix(tui): 多选回车=勾选当前项,「完成」行才提交`

## 分支与 PR
- 从 `master` 切分支(别直接推 `master`)。
- PR 描述写清:**做了什么、为什么、怎么验证**;关联 issue(`Closes #123`)。
- 保持 PR 聚焦单一主题;CI 必须绿。

## 代码风格
- TypeScript(strict);ESLint 把关。跟随周边代码的命名/注释密度/习惯,别引入新风格。
- 注释讲**原理与取舍**,不复述代码。

## 项目结构(速览)
```
src/
  agent/      # 主循环 loop、子代理、压缩、后台任务、worktree
  client/     # DeepSeek 流式客户端 + 恢复链
  tools/      # ~40 个工具 + 执行器 + 权限相关 fs/sandbox
  permissions/# 权限门、规则引擎、分类器、bash 安全、秘密扫描
  memory/     # 三层记忆 + 蒸馏 + 校验
  skills/ mcp/ session/ prompt/ tui/ config/
```

## 行为准则
参与即代表你认同 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。安全问题请走 [SECURITY.md](./SECURITY.md)(勿开公开 issue)。
