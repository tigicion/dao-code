# 缓存审计(Cache Audit)设计

**日期**:2026-06-16
**状态**:已批准设计,待转实现计划

## 1. 目标与动机

让 DAO CODE 把"前缀缓存命中"的逐次调用数据**常驻、静默地落盘**,使得:

> 给定一个 session id,审计人员(开发者或 Claude)读**一个文件**,就能复盘整棵 agent 树每一次 API 调用的缓存表现,定位缓存掉的**根因**(是哪个 agent、哪一轮、哪一维破的;还是 TTL 过期),并验证 fork 等缓存优化是否真生效。

普通用户正常使用**无感**(只是会话目录里多一个小文件);分析是开发者按需触发,不进普通用户视野。

### 现状缺口(为什么要做)

- **主会话**:`Session.usage` 仅在内存累计;`SessionEvent` 定义了 `{ t: "usage" }` 但从未被 append → 逐轮数据不落盘。
- **子 agent**(`subagent.ts:31`):每个子 agent 用独立 `new Session(...)`,且 `SubagentDeps` 不含 `store` → 它的 usage/命中率/骤降/维度归因在 `runSubagent` 返回时**全部蒸发**。`writeTranscript`(`index.ts:571`)只写 `sub.messages`,无 usage,且文件名(时间戳-随机)与父会话**无关联**。
- **fork agent**(`index.ts:583`)故意复用父对话已缓存前缀省钱,但**是否真命中父缓存当前完全无法验证**。
- **三个隐藏工具调用**也吃缓存预算、记进主 session:classifier(`index.ts:458`)、summary(`693`)、distill(`786`),均为 flash 模型。

## 2. 范围

### In scope
- 一个**独立** `cache.jsonl`,每会话一份,落在会话目录 `(.dao/sessions/<id>/cache.jsonl)`。
- 主会话、子 agent、fork agent、后台 agent、以及 classifier/summary/distill 三个工具调用——**全部**每次 API 调用追加一条审计记录,汇入**根会话的同一条流**。
  - **路径范围**:审计绑定【持久化的交互式(TTY)会话】——即有 session id、可按 id 审计的会话。无状态的一次性调用(`dao "prompt"`、管道/CI/eval)不创建会话 store、无 session id,故【刻意不审计】(与其已有的"不蒸馏/不做检查点"一致)。
- 每条记录含:四维前缀指纹哈希、变更维度的内容/diff(仅变化时记)、ts、token 明细(hit/miss/prompt/completion)、agent 树身份(main/sub/fork/bg/util + depth + subId + turn)。
- 一个开发者命令 `/cache [id]` 触发分析渲染(默认审当前会话)。

### Out of scope(YAGNI / 留作下一步)
- 消息级哈希以精确到"前缀在第几个 token 断"(DeepSeek 只回 hit/miss 总量,定位到维已足够;token 级定位 v2 再说)。
- Anthropic 风格 `cache_control` 主动缓存断点(DeepSeek 扁平设计不支持)。
- 可视化趋势图。
- 无状态一次性/非 TTY 运行的审计(无 session id 可供按 id 审计;与不蒸馏一致)。

## 3. 架构

### 3.1 数据落点

```
.dao/sessions/<rootSessionId>/
  ├── events.jsonl     # 既有:完整对话真相流(不动)
  ├── state.json       # 既有:恢复快照(不动)
  ├── meta.json        # 既有
  └── cache.jsonl      # 新增:纯缓存审计流(本设计)
```

`cache.jsonl` 与 `events.jsonl` **分离**:审计时只读纯缓存数据,不被对话转录稀释。子 agent / 后台 agent 的记录也写进**根会话的** `cache.jsonl`(单流汇聚),而非各自独立文件——这样一个 id、一个文件看全树,且能跨 agent 比对(fork vs 父)。

### 3.2 记录 schema(每次 API 调用一条)

```jsonc
{
  "ts": 1718524800000,          // append 写入时补(既有 append 机制已加 ts)
  "agent": "main",              // main | sub | fork | bg | classifier | summary | distill
  "subId": "ab3f",              // 子/后台 agent 的短 id;main 为空
  "depth": 0,                   // subagentDepth;main=0
  "turn": 7,                    // 该 agent 内的回合序号
  "model": "deepseek-v4-pro",
  "prompt": 21000,              // prompt_tokens
  "hit": 1000,                  // prompt_cache_hit_tokens
  "miss": 20000,                // prompt_cache_miss_tokens
  "completion": 320,
  "ratio": 0.048,               // hit/prompt,渲染期也可算,落盘冗余便于离线 grep
  "fp": {                       // 四维前缀指纹哈希(复用现有 notePrefix/cheapHash)
    "model": "h_m1",
    "sys":   "h_s2",            // 系统提示(messages[0])
    "tools": "h_t1",            // 工具定义集序列化
    "tail":  "h_x1"            // 尾部注入(transient + advisory)
  },
  "changed": ["sys"],           // 相对上一条同-agent记录,哪些维哈希变了;无变化为 []
  "delta": {                    // 仅当 changed 非空:记变化维的可诊断内容/diff
    "sys": { "fromLen": 8200, "toLen": 8460, "diff": "+<memory>…新增段…" }
  }
}
```

**设计要点**:
- 稳态每条只多四个哈希 + token 数字 → 极小。
- `delta` 只在某维**哈希变化时**才记内容/diff,稳态不带 → 文件不膨胀,但破缓存时有足够料定位"具体改了什么"。
- `ts` 让审计可算**空闲间隔** → 区分 TTL 过期(四维全稳 + 间隔 > ~5min)与真破缓存(我们的锅)。

### 3.3 写入路径

复用现有 `appendFileSync`(`log.ts:90` 同款,小行 append 对并发后台 agent 近似原子)。落盘时机:每次 API 调用 `onUsage` 到达时(轮末,流已结束,不阻塞生成)。

新增一个轻量审计 sink 接口(不复用重的 `SessionStore`,因为子 agent 不应拿到完整 store):

```ts
export interface CacheAuditSink {
  record(e: CacheAuditEvent): void;   // append 一条到根会话 cache.jsonl
}
```

- 主循环:在 `onUsage`(`loop.ts:120` 那条 `session.addUsage` 旁)调用 `sink.record(...)`,身份 `main`。
- 三个工具调用(`index.ts:458/693/786`):各自 `onUsage` 旁加 `sink.record(...)`,身份 `classifier/summary/distill`。
- 子 / fork / 后台 agent:`SubagentDeps` 新增可选 `auditSink`(**指向根会话的同一 sink**)+ 该子 agent 的身份元信息(agent 类型 / subId / depth)。`runSubagent` 把 sink 透传进 `runTurn`,使子 agent 的 `onUsage` 也写进**根** `cache.jsonl`。

指纹来源:复用现有 `session.notePrefix`/`changedDims`(`session.ts`、`loop.ts:104`)。审计 sink 在 `notePrefix` 之后读取当前指纹与上一条对比产出 `changed`/`delta`。

### 3.4 常驻 vs 触发

- **写**:常驻静默,默认开。环境变量 `DAO_CACHE_AUDIT=0` 可关闭(洁癖/极端隐私场景)。理由:免费(无 API、不破缓存),且缓存掉 TTL/时序相关、事后无法复现,触发式记录形同虚设。
- **读/分析**:开发者按需。`/cache [id]` 命令渲染;或把 id/文件交给 Claude 离线审计。普通用户不接触。

### 3.5 `/cache` 命令

- `/cache`:审**当前**会话。先打印 `会话 id: <id> · cache.jsonl: <path>`,再渲染逐轮命中率表 + 标注破缓存的轮次/维度 + TTL 嫌疑。
- `/cache <id>`:审指定历史会话(`/resume` 可列出 id)。
- 子 agent 记录在表中以缩进 / `sub#<subId>@depth` 前缀区分,与主流时间线交错可读。

## 4. 审计能力(交付的"定位根因"能力)

给定 session id,审计可产出**两类确定结论之一**:

1. **真破缓存(可修)**:指名 agent + 轮次 + 维度 + 具体改动。
   - 例:"子 agent#ab3f 第 7 轮,`tools` 维变化——工具序列化 key 重排;diff: …"
   - 例:"主会话第 12 轮,`sys` 维变化——易变 token 漏进固定前缀;delta 显示新增 `<当前时间>`"
2. **TTL 过期(非 bug)**:"四维全稳,距上次调用空闲 6.2min > ~5min TTL,服务端缓存过期,符合预期"。

并顺带验证 fork 优化:对比 fork 首调的 `ratio` 与父会话对应记录的 `fp`——指纹一致却 `ratio≈0` 即为真 bug(fork 未真命中父缓存)。

**边界(诚实声明)**:DeepSeek 只回 hit/miss 总量,不回前缀断点的 token 位置;本设计定位到"哪一维"为止,token 级定位需消息级哈希,属 v2。

## 5. 测试策略

- **单测**:审计 sink 在指纹变化时产出正确 `changed`/`delta`;稳态不带 `delta`;TTL 间隔判定。
- **集成**:跑一轮带子 agent 的会话,断言根 `cache.jsonl` 同时含 `main` 与 `sub` 记录、subId/depth 正确、父子写入同一文件。
- **回归**:`DAO_CACHE_AUDIT=0` 时不产生 `cache.jsonl`,且不影响既有行为。
- **fork**:构造 fork,断言其首条记录的 `fp.sys/fp.tools` 与父最后一条一致(验证 fork 复用前缀的前提成立)。

## 6. 性能与代价(已确认)

- **额外 API 调用**:零。usage 已随现有流(`stream_options.include_usage`)返回,只是把到手数据多写一份。
- **不破缓存**:`cache.jsonl` 是本地日志,与发往 DeepSeek 的请求体无关,前缀零改动。
- **运行开销**:每次 API 调用末尾多一次 `appendFileSync`(与既有每轮多次写盘同量级,埋在噪声里;usage 在轮末到达,不阻塞生成)。
- **`/cache` 读取**:按需触发,只读本地文件,随会话长度线性(几千轮也仅数十 ms)。

## 7. 关键文件改动清单(实现时参考)

| 文件 | 改动 |
|---|---|
| `src/session/log.ts` 或新文件 `src/session/cache_audit.ts` | 新增 `CacheAuditSink` / `CacheAuditEvent` 与 `createCacheAuditSink(sessionDir)` |
| `src/agent/loop.ts` | `TurnDeps` 加可选 `auditSink` + agent 身份;`onUsage` 旁 `sink.record(...)` |
| `src/agent/subagent.ts` | `SubagentDeps` 加 `auditSink` + 身份元信息,透传进 `runTurn` |
| `src/index.ts` | 创建根 sink;主循环、三个工具调用、`runSubagent`/`runForkAgent`/`runBackgroundAgent` 注入同一根 sink;`DAO_CACHE_AUDIT` 开关 |
| `src/commands/*` | 新增 `/cache [id]` 命令读 `cache.jsonl` 渲染 |
| `*.test.ts` | 见第 5 节 |
```
