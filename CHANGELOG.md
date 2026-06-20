# 更新日志 / Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.14] - 2026-06-20

首个公开发布;以下为自 MVP(0.1.2)起的累积变更。

### 新增
- **profile 凭证体系**:多 key / 多 provider 就绪,交互式 `/account` 选择器,`/login`·`/logout` 统一 onboarding。
- **技能体系**:内置核心技能扩到 5 个(simplify / debugging / tdd / planning / code-review),对齐 writing-skills 写作标准;可单个或批量 `/skills` 开关,外来技能首次加载按用途自动转换工具名/模型档并缓存。
- **长任务稳健**:流式→非流式降级、反应式压缩(上下文超限自动压缩重试)、压缩降级阶梯 + 熔断、模型回退、advisor 空转/临近上限提醒、增量压缩、真实 token 触发压缩。
- **错误恢复**:`max_output_tokens` 截断续写补全、`Retry-After` honoring、背景查询 529 不重试(防并行子代理级联)。
- **安全纵深**:危险命令黑名单、敏感目标 bypass-immune、Unicode 消毒、秘密扫描、子进程 env 脱敏、SSRF 防护、目录信任(`dao trust`)、审计日志、可选 OS 沙箱(`DAO_SANDBOX`)与系统钥匙串(`DAO_USE_KEYCHAIN`)。
- **成本**:人民币计费(按模型分价)+ 可选预算提醒;`explore` 子代理与 coordinator 研究阶段走 flash 省成本。
- **能力**:`/goal <目标>` 一键长任务、`verify_done`/DoD 验收、todo 穿越压缩、OS crontab 定时调度、fork 子代理(复用前缀缓存)、MCP 崩溃自动重连、桌面通知 + 防休眠、启动更新检查、Lite-Log 秒列 `/resume`、插件多组件(commands/agents/hooks)、编辑后诊断回灌(`DAO_DIAGNOSTICS`)。

### 变更
- `/task` 改名 `/goal`(`/task` 保留为别名),`/goal <目标>` 直接开跑。
- 模式图标改单色单宽字形(∞/⊙/❖/※/◇/✎)。
- 「其他(自己输入)」选项改为内联输入行(灰色提示 + 聚焦即可打字)。
- 缓存命中骤降埋点 + 归因(`--verbose`)。

### 工程
- 开源准备:SECURITY / CONTRIBUTING / CODE_OF_CONDUCT / CHANGELOG / issue·PR 模板 / ESLint + CI lint / dependabot。

## [0.1.2]
- MVP:Ink TUI、流式 + 工具 + 审批、ESC 打断、三层持久记忆、prompt-cache 感知、技能/插件/MCP 扩展、会话持久化与 `/resume`。
