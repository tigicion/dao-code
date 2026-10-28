# Hermes 记忆：Dao 实现与使用

Dao 默认采用固定上游 `NousResearch/hermes-agent@1ae3c55e4bb16f495ebf0536a5672782d903e15e` 的记忆闭环，原生 TypeScript 实现。完整设计见 [替换方案](../design/specs/2026-10-27-hermes-memory-replacement-trd.md)，源码理解见 [上游分析](hermes-memory-analysis.md)，许可和明确差异见 [UPSTREAM](../../third_party/hermes-memory/UPSTREAM.md)。

## 当前运行路径

- **常驻事实**：`~/.dao/memories/MEMORY.md`（2200 Unicode 字符）、`USER.md`（1375）。`memory` 工具按单目标整批 add/patch/remove，最终预算校验、精确匹配、威胁扫描和原子替换。没有 importance、相似度合并或自动遗忘。
- **历史原文**：每会话 `session.db` 保存稳定消息 ID、原始正文、实际 API 副本和压缩状态。`~/.dao/history.db` 是可重建 FTS5 投影；outbox 支持幂等重放。`session_search` 支持发现、会话读取、消息周边与浏览。中文使用字面匹配回退，不承诺同义改写召回。
- **上下文**：普通记忆写入不重写当前系统前缀。压缩先持久化原文，再生成摘要、保留近期原文和工具配对，提交成功后更新记忆／技能快照。失败保留原始证据；正常会话恢复沿用持久化快照。
- **学习**：真实用户回合每 10 次提示检查事实，模型迭代每 10 次触发技能复盘。完整回复后后台执行，最多 16 次迭代并限制累计输入；继承实际请求工具声明，执行端另设白名单。新用户输入取消复盘，迟到响应不能继续写。一次性执行、评测、计划模式不自动复盘。费用计入会话，审计区分后台用途。
- **技能**：`skills_list`、`skill_view`、`skill_manage` 管理任务经验。已有 `Skill` 继续加载项目／安装技能，`SkillInstall` 保留安装入口。编辑前必须读当前内容；保留来源、支持文件和可恢复备份。合并把完整原包保留在新包的 `merged/` 目录，原包另行归档。
- **维护**：Curator 默认每 168 小时检查、至少空闲 2 小时、首次仅建立时钟；14 天 stale、30 天 archive。只自动处理合格的 agent-created 包；pin 和定时任务引用受保护。无法确认 crontab 引用时跳过维护，不猜测。合并默认关闭。

旧提取／统一反思写入、启动 GC／合并、三层注入及默认 Mem0 后端已从主代理接线退出。旧源文件和测试保留用于迁移与历史兼容，不是第二套活跃策略。独立 challenger／refocuser 和任务持久恢复继续使用。

## 常用命令

```sh
dao memory status
dao --profile work                  # 独立学习 profile，不等同于模型账号
dao --no-memory                     # 不加载事实、不检索历史、不接外部 provider、不自动学习
dao memory pending
dao memory approve <proposal-id>
dao memory reject <proposal-id>
dao memory audit
dao memory history import /absolute/path/to/.dao/sessions/<id>
dao memory history rebuild
dao memory fork-session /absolute/path/to/.dao/sessions/<legacy-id>
dao curator status
dao curator run                     # dry-run；仍遵守维护时间门槛
dao curator run --apply
dao curator pin <skill-slug>
dao curator unpin <skill-slug>
dao curator restore <skill-slug>
dao curator rollback <skill-slug> --backup <backup-id> # 目标不存在时恢复备份
dao curator ledger
```

TUI 交互命令有 `/memory`、`/memory pending|approve|reject`、`/refine`、`/curator` 和 `/audit memory`。后台 memory patch/remove 始终暂存；普通写入受 `memory.write_approval` 控制。`skills.write_approval` 开启后普通技能变更也生成提议。显式权限 deny 仍优先，计划模式不给写工具。

`--no-memory` 不禁用任务恢复数据库；这避免把隐私开关变成崩溃恢复开关。评测不加载真实学习状态。开发／测试可用 `DAO_HOME` 指定完全隔离的 profile 根目录。

同一 profile 在各项目共享事实与历史。严格隔离用独立 profile；不要依赖旧的 project/user/knowledge 记忆分层。

## 配置

profile 的 `settings.json` 允许与原有 Dao 设置共存：

```json
{
  "memory": {
    "memory_enabled": true,
    "user_profile_enabled": true,
    "memory_char_limit": 2200,
    "user_char_limit": 1375,
    "nudge_interval": 10,
    "write_approval": false,
    "provider": ""
  },
  "skills": { "creation_nudge_interval": 10, "write_approval": false },
  "background_review": { "enabled": true, "max_iterations": 16 },
  "curator": {
    "enabled": true, "interval_hours": 168, "min_idle_hours": 2,
    "stale_after_days": 14, "archive_after_days": 30, "consolidate": false
  },
  "compression": { "threshold": 0.5, "protect_last_n": 20, "checkpoint_required": false }
}
```

小于 512K 的上下文采用至少 0.75 的压缩阈值。当前支持本地摘要压缩；不宣称兼容 Hermes 所有模型厂商的专用压缩协议。

外部提供器默认禁用。显式配置 `memory.provider` 和绝对路径 `memory.provider_module` 后，模块导出 `createMemoryProvider()` 并实现 `src/memory/provider.ts` 的接口。支持初始化、回合召回、按序同步、写入镜像、压缩前检查、会话切换、委派和退出。召回等待上限 8 秒，退出排空上限 5 秒；所有出站正文做脱敏，私有 reasoning 不同步。旧 Mem0 存储配置不会自动开启整轮会话同步。Python 插件不能直接载入。

## 无损导出、审查和激活

本次代码实现不会替用户迁移真实记忆。旧文件和本地 Mem0 SQLite 数据保持原状。首次运行发现旧记录会提示迁移。

```sh
dao memory migrate plan
# 返回 plan.json 路径。完整原文和元数据另存 export.json。
# 编辑计划：明确哪些记录进入 memory/user/skill，哪些留 archive。
# targets 展示将写入的完整双文件及技能正文。
dao memory migrate digest /absolute/path/plan.json
dao memory migrate apply /absolute/path/plan.json --accept <digest> --offline
dao memory migrate verify /absolute/path/plan.json
dao memory legacy search <keyword>
dao memory legacy show <record-id>
```

默认计划完整归档，**不擅自把旧推断升级为事实**。选择性激活须在预算内，记录映射与目标全文一致；源漂移、漏项、冲突或超预算会拒绝执行。`--offline` 表示旧写入者已停止；活跃的新运行时另有 lease 检查。跨文件激活通过 journal 记录进度，支持中断重试，不能假定多个 rename 天然原子。

`dao memory migrate rollback <plan.json> --accept <digest> --offline` 导出切换后的增量和独立回滚快照，保留新系统数据。切回旧程序必须使用旧二进制和旧数据快照；不会让旧程序直接读取升级后的活跃会话库，也不会静默把新事实反向猜测成旧类型。

旧会话协议不能直接混用新工具；可只读导入历史，或 fork 成继承会话。旧事件日志是 best-effort，导入明确标注缺失边界；已经丢失的压缩前原文无法恢复。

## 验证边界

自动测试覆盖真实多进程写入、Unicode／最终预算、上游 Python 差分、原文归档／检索、工具权限、后台取消、外部 hook 脱敏、技能维护、迁移和恢复。Node 与 Bun 使用临时 profile 做 CLI 和迁移冒烟，不接真实模型、不触碰用户记忆。

这些结果证明实现契约与集成路径，不代表已证明在真实模型下比旧 Dao 更高的任务通过率或更低的费用。外部服务适配器需单独配置并验证；没有预置开启任何第三方数据同步。

### 本次验收记录（2026-10-27）

- 完整回归：217 个测试文件、2073 个测试通过，含真实上游 MemoryStore 差分和多进程并发写入。
- `npm run typecheck`、`npm run build` 通过；最后修正文件 ESLint 无错误，`git diff --check` 通过。
- Bun 单文件构建通过；Node 与 Bun 分别在临时目录验证两个独立 profile，以及迁移 plan/apply/verify。
- 多工具结果压缩边界补充回归：保留对应 assistant 调用及全部结果，原始大正文不变。
- 未安装覆盖本机 `dao`，未激活真实用户旧数据，未进行真实模型质量／成本对比。
