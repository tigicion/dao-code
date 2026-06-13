# 子系统审计日志(记忆 / 工具 / 权限)+ 总开关 + 统一 /audit 设计

**日期**:2026-06-16
**状态**:已批准设计,待写实现计划

## 1. 目标

给**记忆、工具调用、权限**三个子系统各加一条按会话落盘的审计 trace,使得:

> 给定 session id,读对应 trace 文件就能判断该子系统"运作好坏与原因",据此优化 dao。

并把 dao 现有的 5 条审计流(cache / skill / 新增 memory / tools / perms)收口到**一个统一命令 `/audit`** 下、统一受一个**总开关**控制;`/cache`、`/skills audit` 不再保留。

### 1.1 总开关 `DAO_AUDIT`(当前默认开)

五条审计流统一受一个总开关控制。**当前默认开**(用户决定,后续可一行改默认):

- `DAO_AUDIT=0` → 全部关闭(sink 为 NOOP、零文件、跳过任何仅为审计的预计算);不设或 `=1` → 全部**启用**。
- 每流仍可细粒度覆盖:`DAO_<X>_AUDIT=0/1`,优先于总开关。
- 判定收敛到共享小工具 **`auditEnabled(env, "MEMORY"|"TOOL"|"PERM"|"CACHE"|"SKILL")`**:显式 `DAO_<X>_AUDIT` 取它(`"0"`→false、`"1"`→true),否则回落 `DAO_AUDIT`,**默认 `true`**。各 `create*AuditSink` 用它决定返不返 NOOP。
- **统一**:cache/skill 现各自 `DAO_<X>_AUDIT=0` 关、默认开——改为统一走 `auditEnabled`,语义一致(默认开,`DAO_AUDIT=0` 一键全关)。开关收口到一处,默认值后续可一行改。

### 沿用既有约定(`src/skills/skill_audit.ts` 为模板)

三个新模块严格照 `skill_audit.ts` 的形状,保证一致、可独立测试:
- 领域专用 **sink**(语义方法,如 `recalled/wrote/distilled`),非通用 `record()`。
- `create<X>AuditSink(sessionDir, env)` 工厂;开关用 `auditEnabled`(§1.1),关闭返回零成本 NOOP。
- 落盘 `<sessionDir>/<x>-trace.jsonl`,每行一事件(含 `ts`)。
- 纯函数 `summarize<X>Trace(events)` → 统计;`readAll<X>Traces(sessionsRoot)` 跨会话聚合;`format<X>Report(stats)` 渲染。

### 现状约束(已核实)

- **权限已有半套**:`execute.ts:101` 的 `auditDecision` 写 `.dao/audit.log`,但**工作区级单文件、不按会话、只 write/exec/network、只 allow/deny**。这是**安全日志,本设计不动它**;新增的 `perm-trace.jsonl` 是按会话的优化视角(更全:含 mode / ask 结果 / 来源)。
- **events.jsonl** 已记 `tool_result`(name/ok/content),但无计时、无按工具聚合——故新增 `tool-trace.jsonl` 专做优化分析。
- **skill 审计现为 loaded-only**(discovery 打分预筛已移除):`skill_audit.ts` 只记模型实际加载了哪条(`loaded`)。"**该加载却没加载**"这类判断需上下文感知,**不在本次范围**——靠后续的 LLM 裁判 eval(见 §3.4)。本次对 skill 审计只做一件事:纳入总开关。
- 审计只存在于**持久化交互会话**(有 store、有 session id);无状态一次性运行(`dao "prompt"`/管道/eval)无 store 故不审计——与 cache 审计、蒸馏的既有取舍一致。

## 2. 范围

### In scope
- **总开关 `DAO_AUDIT`(默认开)** + 共享 `auditEnabled(env, key)` 工具;五条流(memory/tools/perms/cache/skill)统一纳入(`DAO_AUDIT=0` 一键全关)。
- 三个新审计模块:`memory_audit.ts` / `tool_audit.ts` / `perm_audit.ts`,各含 sink + summarize + readAll + format。
- 三处埋点接线(记忆召回/写入/蒸馏;工具执行单点;权限裁决)。
- 统一 `/audit <subsystem> [id]` 命令,覆盖 memory/tools/perms/cache/skills/all。
- 删除 `/cache` 命令与 `/skills audit` 子命令;`SLASH_COMMANDS` 去 `cache`、加 `audit`(菜单 + Tab 补全随之更新)。
- 把内联在 index.ts 的 `/cache` 渲染抽成 `cache_audit.ts` 的 `formatCacheReport` 纯函数(供 `/audit cache` 复用、并获得单测)。
- cache/skill 审计开关改用 `auditEnabled`。

### Out of scope（YAGNI）
- 不动 `.dao/audit.log` 安全日志,不动 events.jsonl。
- 无状态/非 TTY 路径的审计(无 session id)。
- 跨会话趋势可视化。
- **"该加载却没加载"的 LLM 裁判 + 标注集校准**——单独的 eval 形态 spec,本次不做(本审计的被动信号可作其输入)。

## 3. 三个审计模块

### 3.1 记忆 `src/memory/memory_audit.ts` · `memory-trace.jsonl` · `DAO_MEMORY_AUDIT`

埋点:
- **召回**(会话启动,`selectForInjection`/`buildMemorySection` 处):注入了几条、剔除几条 stale、几条标记 changed、按 type 分布。
- **写入**(`memory_write` 工具):新建 vs 合并近重复(同类型近似文本合并)、type。
- **蒸馏**(`distillOnExit`):产出几条 created、几条 skipped(catalog 噪声/近重复)。

```ts
export type MemoryTraceEvent =
  | { kind: "recalled"; ts: number; injected: number; stale: number; changed: number; types: Record<string, number> }
  | { kind: "wrote"; ts: number; type: string; merged: boolean }
  | { kind: "distilled"; ts: number; created: number; skipped: number };

export interface MemoryAuditSink {
  recalled(injected: number, stale: number, changed: number, types: Record<string, number>): void;
  wrote(type: string, merged: boolean): void;
  distilled(created: number, skipped: number): void;
}
```
`summarizeMemoryTrace` → 召回规模/stale 比例(store 健康度)、写入次数与**合并率**(去重是否生效)、蒸馏产出。判好坏:stale 比例高=该 gc;合并率低=近重复在膨胀;蒸馏 skipped 高=噪声多。

### 3.2 工具 `src/tools/tool_audit.ts` · `tool-trace.jsonl` · `DAO_TOOL_AUDIT`

埋点:包住 `execute.ts` 的 `dispatchOne`(唯一执行点)——前后取时间算 `durationMs`,据返回判 `ok`。

```ts
export type ToolTraceEvent =
  | { kind: "call"; ts: number; name: string; cap: string; ok: boolean; durationMs: number; args: string };

export interface ToolAuditSink {
  call(name: string, cap: string, ok: boolean, durationMs: number, args: string): void;
}
```
`args` 截断(~120 字符)。`ok` 判定复用 execute.ts 现有 `looksFailed`/`Error` 前缀约定。
`summarizeToolTrace` → 每工具:调用数、**错误率**、平均/最大耗时、总耗时。排序:错误率高或调用最频在前。判好坏:错误率高=工具/用法有问题;耗时长=性能瓶颈;高频=优化重点。

### 3.3 权限 `src/permissions/perm_audit.ts` · `perm-trace.jsonl` · `DAO_PERM_AUDIT`

埋点:`executeToolCalls` 的裁决 + 审批循环——每个工具调用记一条最终决策。

```ts
export type PermTraceEvent =
  | { kind: "decided"; ts: number; tool: string; cap: string; mode: string; decision: "allow" | "deny" | "ask-approved" | "ask-denied"; source: "rule" | "classifier" | "user" | "default" };

export interface PermAuditSink {
  decided(tool: string, cap: string, mode: string, decision: PermTraceEvent["decision"], source: PermTraceEvent["source"]): void;
}
```
`decision`:规则直接 allow/deny;ask 后人工准/驳为 ask-approved/ask-denied。`source`:命中规则=rule;auto 模式分类器放行=classifier;人工审批=user;默认模式=default。
`summarizePermTrace` → 每工具:各决策计数、**询问率**(ask 占比=摩擦)、拒绝率;全局分类器放行占比。判好坏:某工具总被问=可加 allow 白名单;拒绝集中=危险面;分类器放行多=auto 在替你省事。

### 3.4 skill `src/skills/skill_audit.ts` · `skill-trace.jsonl` · `DAO_SKILL_AUDIT`(已存在,本次仅纳入总开关)

discovery 移除后,skill 审计为 **loaded-only**:`{ kind: "loaded"; round; ts; name }`,`SkillStat = { name, loaded, total }`,记模型每轮实际加载了哪条。本次**只把它的开关从 `env.DAO_SKILL_AUDIT === "0"` 改为 `auditEnabled(env,"SKILL")`**,纳入总开关、默认开;指标不动。

**"该加载却没加载"为何不在此**:技能现统一走常驻 name+description、由模型自主判断,没有任何确定性 oracle 能说"本应加载 X"。该判断需**上下文感知的 LLM 裁判**(读任务 + skill 目录 + 实际加载),其自身好坏再靠**人工标注集**校准——属 eval 形态,单独立项(§2 Out of scope)。本审计的 `loaded`(谁、第几轮)是那个 eval 的输入之一。

## 4. 接线(sink 注入)

与 cache 审计同构——会话 store 就绪后创建 sink,经各自路径注入;无 store 的路径自然 NOOP。

- **创建**:index.ts 会话启动(`store` 创建后)建 `memoryAudit`/`toolAudit`/`permAudit` 三个 sink(skillSink 已存在,同处)。沿用 cache 的"外层 `let` 占位 no-op、store 后赋值"避开作用域陷阱。
- **工具 & 权限**:经 `ToolContext` 透传(新增可选 `ctx.toolAudit?`、`ctx.permAudit?`),`dispatchOne`/`executeToolCalls` 从 ctx 取——与现有 `preToolHook`/`postToolHook` 同机制。store 后给 ctx 赋值(ctx 是对象,闭包持引用)。
- **记忆召回**:在内存选择/注入处记一次 `recalled(...)`;若该处早于 store,则记录延后到 store 就绪后用 `selectForInjection` 结果补记(实现计划定具体顺序)。
- **记忆写入**:`memory_write` 工具内,据"读全部→合并→写回"结果判 `merged`,调 `ctx` 上的 sink。
- **记忆蒸馏**:`distillOnExit` 拿到 distill 结果(created/skipped)后记一次。

## 5. 统一命令 `/audit`

```
/audit <memory|tools|perms|cache|skills|all> [id]
```
- 内联命令(index.ts 命令链),返回 `{ handled: true, output }`。
- 解析子系统 + 可选 session id;无 id 审**当前会话**(`store.dir`),给 id 审 `sessionsDir/<id>`。
- 分派到对应 `format*Report`:
  - `memory`/`tools`/`perms`:读各自 `<x>-trace.jsonl` → summarize → format。
  - `cache`:读 `cache.jsonl` → 新抽的 `formatCacheReport`(按会话)。
  - `skills`:`readAllSkillTraces` + `formatSkillReport`(loaded-only;保持现有**跨会话**聚合,忽略 id)。
  - `all`:依次跑五者,拼接输出。
- 坏行跳过、文件缺失给友好提示(照 `/cache` 现有容错)。
- **删除** `/cache` 命令分支与 `/skills` 块内 `sub === "audit"` 分支。
- `SLASH_COMMANDS` 去 `cache`、加 `audit`;补全菜单与 Tab 自动随之(单一真相源)。

## 6. cache 渲染抽取(顺带清理)

把 index.ts 内 `/cache` 的逐轮渲染(命中率行 + 破缓存维度 + TTL 判定)抽成 `cache_audit.ts` 的纯函数:
```ts
export function formatCacheReport(events: CacheAuditEvent[], ttlMs?: number): string;
```
`/audit cache` 调它。好处:与其它 `format*Report` 一致、可单测、index.ts 命令块变薄。

## 7. 测试

- `auditEnabled`:`DAO_AUDIT` 默认 true;`=0` 全关;`DAO_<X>_AUDIT` 覆盖优先。
- 每新模块照 `skill_audit.test.ts`:sink 落盘一行一事件;关时不建文件;坏行被 `readAll` 跳过;`summarize*` 关键指标正确(合并率 / 错误率 / 询问率 / stale 比例)。
- `formatCacheReport` 纯函数单测(逐轮行 + TTL 标注 + 破缓存维度)。
- `/audit` 命令:`tui/app/App.test.tsx` 模拟键入,验证 Tab 能补 `/audit`;命令分派靠各 format 函数的单测兜底(命令块本身按现有内联命令惯例不单独测)。

## 8. 性能与代价

- **默认开,但成本极低**:**零额外 API**;sink 都是本地小行 `appendFileSync`,埋在现有写盘噪声里;工具计时仅 `Date.now()` 前后两次,可忽略;每会话多几个小 jsonl。
- **一键全关**:`DAO_AUDIT=0` → 所有 sink NOOP、不建文件、跳过仅为审计的预计算。细粒度 `DAO_<X>_AUDIT=0/1` 逐项覆盖。
- `/audit` 按需读本地文件。

## 9. 关键文件改动清单(实现参考)

| 文件 | 改动 |
|---|---|
| `src/session/audit_switch.ts` + `.test.ts` | 新建:`auditEnabled(env, key)` 共享开关判定(§1.1) |
| `src/memory/memory_audit.ts` + `.test.ts` | 新建 |
| `src/tools/tool_audit.ts` + `.test.ts` | 新建 |
| `src/permissions/perm_audit.ts` + `.test.ts` | 新建 |
| `src/session/cache_audit.ts` + `.test.ts` | 加 `formatCacheReport` + 单测;开关改用 `auditEnabled` |
| `src/skills/skill_audit.ts` | 开关由 `DAO_SKILL_AUDIT==="0"` 改用 `auditEnabled(env,"SKILL")`,指标不动(已 loaded-only) |
| `src/tools/types.ts` | `ToolContext` 加 `toolAudit?` / `permAudit?` |
| `src/tools/execute.ts` | `dispatchOne` 计时记 `call`;裁决循环记 `decided` |
| `src/memory/memory_write.ts` | 写入记 `wrote(type, merged)` |
| `src/index.ts` | 建三 sink + 注入;`distillOnExit` 记 `distilled`;召回记 `recalled`;新增 `/audit`;删 `/cache` 块(~1025)与 `/skills` 块内的 `sub === "audit"` 分支(~970) |
| `src/tui/app/App.tsx` | `SLASH_COMMANDS` 去 cache 加 audit |
