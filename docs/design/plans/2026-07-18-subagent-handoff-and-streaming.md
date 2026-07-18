# 设计:F(子代理 handoff 安全审查) + G(runAgent 消息逐条流式)

> **背景**:子代理系统 review 中发现两个故意延期的问题,需要设计而非随手接线。
> F: `classifyHandoffIfNeeded` 函数已写好但生产代码从未调用--auto 模式下子代理执行完不做安全审查就返回。
> G: `runAgent` 等 `runTurn` 整个跑完才一次性 yield 消息,不是逐条流式--后台子代理的进度/中途发现无法实时流回父代理。

---

## F: 子代理 Handoff 安全审查

### 现状

- `agent_handoff.ts` 实现了 `classifyHandoffIfNeeded`,有 5 个单元测试,全绿。
- grep 确认:`index.ts`、`agent.ts`、`runAgent.ts`、`agent_lifecycle.ts` 中无任何调用。
- 函数签名已有 `classifyFn?` 注入口,但没人传。
- 现有 `classifier.ts` 的 `buildClassifierTranscript` 只取 user 文本 + assistant tool_calls(排除 assistant 自由文本,防操纵),输出紧凑 JSONL。
- CC 的 `classifyHandoffIfNeeded`(`agentToolUtils.ts:389`)在子代理完成后调 `classifyYoloAction`,审查整段子代理转录,返回警告字符串或 null。警告前缀到子代理返回文本前面(`finalMessage = handoffWarning + finalMessage`)。两处调用点:同步路径(AgentTool.tsx:1238)和异步路径(AgentTool.tsx:963)。

### 问题

需要设计两件事:
1. **审查 prompt**:现有 `classifier.ts` 的 system prompt 是给单次工具调用分类的("allow 还是 deny"),不适合审阅整段子代理转录。需要一个 handoff 专用 prompt。
2. **接线点**:`classifyHandoffIfNeeded` 在哪调、结果怎么处理。

### 设计

#### F-1: handoff 审查 prompt

不复用 `classifier.ts` 的 `buildClassifierMessages`(那是单次工具调用判定)。新写一个 `buildHandoffClassifierMessages`:

- **System prompt**:角色是"auto 模式安全审查器",审阅子代理整段执行转录,判断是否有违反安全策略的操作。不是 allow/deny 二分,而是"有风险 -> 返回原因"或"安全 -> 返回 allow"。
- **应标记**:不可逆操作(rm -rf、drop table、force push)、凭据泄露(.ssh/.aws/.env 读写)、工作区外写入、与任务无关的危险操作、向外部端点发送数据。
- **不标记**:与用户意图一致的可逆操作、工作区内正常编辑、只读操作。
- **User 内容**:子代理的紧凑转录(JSONL 格式,复用 `buildClassifierTranscript`),末尾附审查指令。
- **输出格式**:XML,与现有 classifier 一致--`<decision>allow|block</decision><reason>...</reason>`。

#### F-2: classifyFn 实现

`classifyHandoffIfNeeded` 的 `classifyFn` 参数需要一个 `(transcript: string) => Promise<ClassifyResult>` 实现。

**方案**:在 `index.ts` 装配时注入一个闭包,内部调 `streamChat` 发分类请求(用 flash 模型,同现有 auto 分类器):

```
const handoffClassifyFn = (transcript: string) => {
  // 构建 messages -> 调 streamChat(flash) -> 解析 XML -> 返回 {shouldBlock, reason}
};
```

**不走的路径**:
- 不用 `PermissionGate.classify`(那是单次工具调用的,签名不匹配)。
- 不用 CC 的两阶段 XML 分类器(过于复杂,DAO 的单次分类器已够用)。

#### F-3: 接线点

两处,对齐 CC 的双调用点:

**同步路径**(`agent.ts` 的 `runOne` 兜底路径 + 有 taskManager 的前台路径):
- `finalizeAgentTool` 之后、`return` 之前调 `classifyHandoffIfNeeded`。
- 返回值非 null -> 前缀到返回文本:`return warning + "\n\n" + text`。

**异步路径**(`agent_lifecycle.ts` 的 try 块末尾):
- `finalize()` 之后、`taskManager.update(completed)` 之前调。
- 返回值非 null -> 前缀到 result:`taskManager.update(taskId, { status: "completed", result: warning + "\n\n" + text })`。

#### F-4: 只在 auto 模式触发

- `classifyHandoffIfNeeded` 内部已检查 `permissionMode !== "auto"` -> return null。
- 需要把当前权限模式传进去。`agent.ts` 有 `ctx` 但没有直接的 mode 获取方式--从 `ctx` 的 gate 实例取,或从 `ToolContext` 新增字段。
- **最简方案**:`agent_lifecycle.ts` 和 `agent.ts` 都已有 `ctx`,从中取 gate 的 mode。但 gate 的 mode 是 `PermissionGate` 的 private getter。
- **替代**:在 `RunAgentParams` 加一个 `permissionMode?: string` 字段,由 `index.ts` 装配时注入(`gate.getMode()` 或已有的 mode 变量)。

#### F-5: classifyFn 注入路径

`classifyHandoffIfNeeded` 的 `classifyFn` 来自哪里?

**方案**:`RunAsyncAgentLifecycleOpts` 和 `agent.ts` 的 `runOne` 都需要拿到 `classifyFn`。通过 `ToolContext` 传递:

- `ToolContext` 加 `handoffClassifyFn?: (transcript: string) => Promise<ClassifyResult>`。
- `index.ts` 装配时创建闭包并注入。
- `agent.ts` 的 `runOne` 从 `ctx.handoffClassifyFn` 取,传给 `classifyHandoffIfNeeded`。
- `agent_lifecycle.ts` 的 `RunAsyncAgentLifecycleOpts` 加 `classifyFn` 字段,由 `agent.ts` 透传。

#### F-6: 边界

- **分类器不可用**:`classifyFn` 抛错或返回 `unavailable` -> 前缀"注意:安全分类器不可用"警告(fail-open with warning,同 CC)。
- **非 auto 模式**:直接跳过,无开销。
- **短转录**(agentMessages 少):仍然审查(只读 agent 也可能执行了危险操作)。
- **缓存安全**:审查在子代理结束后才调,不影响子代理运行时的前缀缓存。

### 文件影响

| 文件 | 改动 |
|------|------|
| `src/agent/agent_handoff.ts` | 加 `buildHandoffClassifierMessages`;`classifyHandoffIfNeeded` 加 `classifyFn` 默认实现(可选) |
| `src/tools/types.ts` | `ToolContext` 加 `handoffClassifyFn?` |
| `src/agent/agent_lifecycle.ts` | `RunAsyncAgentLifecycleOpts` 加 `classifyFn?`;try 块末尾调 `classifyHandoffIfNeeded` |
| `src/tools/agent.ts` | `runOne` 两条返回路径(同步+兜底)调 `classifyHandoffIfNeeded` |
| `src/index.ts` | 创建 `handoffClassifyFn` 闭包注入 `ctx` |
| 测试 | 上述各处 |

---

## G: runAgent 消息逐条流式

### 现状

`runAgent.ts:296-318`:
```ts
await runTurn({ session: sub, ... });  // 阻塞到整个回合循环结束
// 然后 for 循环 yield sub.messages[initialMessages.length..]
```

`runTurn` 是 `Promise<void>`,内部跑完整个"模型请求 -> 工具执行 -> 再请求"循环后才返回。期间 `sub.messages` 不断增长,但 `runAgent` 的 yield 循环在 `runTurn` 返回后才执行。

**后果**:
- 后台子代理(`runAsyncAgentLifecycle`)的 `for await (const msg of stream)` 实际上是一次性收到所有消息,不是逐条流式。
- `taskManager.appendMessage` 批量触发而非逐条触发--`task_get` 看不到实时进度。
- `message_parent` 工具虽然能发中途消息,但子代理自身的消息流不是实时的。

### 问题

`runTurn` 的设计是"跑完整个回合循环"返回 `Promise<void>`,不 yield 中间消息。要改成逐条流式,有两条路:

1. **改 `runTurn` 为 AsyncGenerator**:影响面巨大--主循环、子代理、压缩、诊断全部依赖 `runTurn` 的 `Promise<void>` 签名。
2. **在 `runAgent` 内部轮询 `sub.messages`**:不碰 `runTurn` 签名,在 `runTurn` 跑着的同时定期检查 `sub.messages` 是否增长,新消息就 yield。

### 设计

**选方案 2(轮询),不改 `runTurn` 签名。**

理由:
- 方案 1 影响面横跨主循环+子代理+压缩,是 G 延期的根本原因。
- 方案 2 利用了 `sub.messages` 是引用数组、`runTurn` 往里 push 的事实--`runAgent` 在另一个"线程"(Promise.race)里观察这个数组的增长即可。
- 轮询间隔不需要很细(200ms 足够)--后台子代理的进度展示不需要 token 级实时性。

#### G-1: runAgent 阶段 5 改造

把"先 await runTurn 再 for yield"改成"边跑边 yield":

```ts
// 阶段 5:查询循环(流式)
const tracker = createProgressTracker();
let runTurnError: unknown;

// runTurn 在后台跑,往 sub.messages push 消息
const runTurnPromise = (async () => {
  if (runTurn && config && streamChat && executeToolCalls && gate) {
    await runTurn({ session: sub, ... });
  }
})();

// 同时,轮询 sub.messages 增长并逐条 yield
let yieldedCount = initialMessages.length;
const POLL_MS = 200;
while (true) {
  // 检查是否有新消息
  while (yieldedCount < sub.messages.length) {
    const msg = sub.messages[yieldedCount]!;
    onQueryProgress?.();
    tracker.updateFromMessage(msg);
    void recordSidechainMessage(subagentsDir, agentId, msg).catch(() => {});
    yield msg;
    yieldedCount++;
  }
  // runTurn 是否结束?
  const settled = await Promise.race([
    runTurnPromise.then(() => true).catch((e) => { runTurnError = e; return true; }),
    new Promise<boolean>((r) => setTimeout(() => r(false), POLL_MS)),
  ]);
  if (settled) break;
}

// flush runTurn 可能 push 的最后几条消息(runTurn resolve 和最后一次 poll 之间的竞态)
while (yieldedCount < sub.messages.length) {
  const msg = sub.messages[yieldedCount]!;
  onQueryProgress?.();
  tracker.updateFromMessage(msg);
  void recordSidechainMessage(subagentsDir, agentId, msg).catch(() => {});
  yield msg;
  yieldedCount++;
}

if (runTurnError) throw runTurnError;
```

#### G-2: 缓存安全

轮询不修改 `sub.messages`(只读索引),不碰 API 请求前缀,不影响缓存。

#### G-3: 输出 buffer

现有代码把 `runTurn` 的 `write` 回调攒到 `buf` 数组,跑完后 flush。流式模式下不需要改这个--`write` 输出(终端渲染)和消息 yield(给上层消费)是两个独立通道:
- `write` buffer 保持不变(防并发子代理输出交织)。
- 消息 yield 改为流式(给 `runAsyncAgentLifecycle` 逐条消费)。

#### G-4: onQueryProgress

现有代码在 for 循环里调 `onQueryProgress?.()`。流式模式下每 yield 一条消息就调一次--更频繁、更准确。

#### G-5: 边界

- **runTurn 抛错**:`runTurnPromise.catch` 捕获,设 `runTurnError`,break 循环后 throw。已 yield 的消息不丢。
- **abort**:`runTurn` 内部处理 abort(返回 void),轮询循环正常 break。
- **无 runTurn(测试环境)**:`runTurnPromise` 立即 resolve,while 循环跑一次就 break,行为同旧版。
- **~~POLL_MS=200~~(已改为事件驱动)**:最初方案是 200ms 轮询,后来发现同进程同事件循环内自己写的数组没道理靠轮询感知自己的变化——改为给 `sub.messages` 包一层 `withPushNotifier`,`runTurn` 每次 `push()` 时同步唤醒查询循环,不再有固定周期、不再有中间消息的轮询延迟,`DAO_AGENT_POLL_MS` 环境变量已随之移除。

### 文件影响

| 文件 | 改动 |
|------|------|
| `src/agent/runAgent.ts` | 阶段 5 从"先跑后 yield"改为"边跑边 yield"(Promise.race 轮询) |
| 测试 | `runAgent.test.ts` 验证消息在 runTurn 期间就能 yield(而非跑完后) |

### 不做的事

- **不改 `runTurn` 签名**:它仍然是 `(deps: TurnDeps) => Promise<void>`。
- **不做 token 级流式**:轮询粒度是消息级(assistant/tool 消息),不是 stream delta。
- **不改 `agent_lifecycle.ts`**:`for await (const msg of stream)` 已经是逐条消费的,只要 `runAgent` 改成流式 yield,它自动受益。

---

## 实施顺序

1. **F 先于 G**:F 是安全相关,G 是体验相关。
2. F 内部:F-1(prompt)→ F-5(注入路径)→ F-3(接线)→ F-4(mode 传递)→ 测试
3. G 内部:G-1(阶段 5 改造)→ G-5(边界测试)→ 全量回归
