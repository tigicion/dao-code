# Agent 对比分析

> 面向 deepseek-v4-pro coding agent 实现，对比 Claude Code、DAO CODE 及其他 agent 的设计。
> 当前重点：CC vs DAO 的五大特色功能对比 + 可借鉴实现。

## 文档清单

| 文件 | 内容 |
|---|---|
| `cc-vs-dao.md` | CC 与 DAO 在记忆、长任务、Skill、缓存、UI 五方面的逐项对比，标注借鉴点和具体实现 |
| `cc-borrowable-patterns.md` | 从 CC 可借鉴的代码模式，含可直接参考的 TypeScript 实现代码 |
| （待补） | CodeWhale 宪法设计分析 |
| （待补） | 其他 agent（OpenCode/OpenClaw 等）对比 |

## 三项目路径

| 项目 | 路径 | 对标方向 |
|---|---|---|
| **Claude Code** | `/Users/huaruoxu/ClaudeProject/claude-code` | 功能对标 |
| **DAO CODE** | `/Users/huaruoxu/ClaudeProject/career_plan/code/codeds` | 本项目 |
| **CodeWhale** | `/Users/huaruoxu/ClaudeProject/career_plan/code/week3/CodeWhale` | 宪法对标 |

## 五大特色功能对标总览

| 功能 | CC 优势 | DAO 优势 | 结论 |
|---|---|---|---|
| **记忆** | feedback 类型、Why+How 体结构、不记什么清单 | 确定性验证、数学化 GC、灰区 flash 裁判 | **互补**：DAO 的机制更强，CC 的分类更好 |
| **长任务** | 状态机、消息队列解耦、Stall Watchdog | 卡死检测、影子 git、超大输出落盘 | **互补**：各有所长 |
| **Skill** | 17 bundled skills + disk-based 加载 | 无 | **CC 碾压** |
| **缓存** | Fork 前缀共享 | 有单元测试保证、DAO 的 spill 更好 | **互补**：借鉴 CC 的 fork，保留 DAO 的测试 |
| **UI** | 140 组件、后台 pill、进度追踪 | 太极欢迎屏、亮暗自适应 | **CC 更丰富** |
