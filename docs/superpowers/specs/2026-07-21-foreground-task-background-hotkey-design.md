# 前台任务快捷键转后台

## 背景与问题

dao 交互模式下,`Bash`(前台执行)和 `Agent`(前台调用,未传 `background:true`)都会阻塞主循环直到跑完。当前的设计原则是:前台/后台是"依赖关系判断",不是"耗时判断"——模型选前台是因为下一步依赖这个结果,系统不应该因为耗时长就背着模型偷偷把它转成后台(`src/tools/agent.ts` 的工具描述里明确写了这条:"前台调用会老实等到跑完,不会因为耗时长就被偷偷转后台")。这条原则是对的,不该改。

但这条原则只约束"系统自动判断",没有覆盖"人盯着屏幕、明确看到这次不该再等下去"的场景。用户此时除了 ESC(整回合粒度,连带砍掉本回合已经产出的其它进展)之外,没有别的手段——只能眼睁睁等前台调用跑完或超时。

## 设计目标

在交互模式下,给用户一个快捷键(Ctrl+B),当前有前台调用正在跑时按下,把它(们)转成后台继续执行,主循环立刻恢复响应,用户可以继续输入或做别的事;后台任务完成后走现有的异步通知链路正常回灌结果。

这是"人工显式操作",不是系统自动判断,因此不违反上面那条既有原则——决定权始终在盯着屏幕的人,不在系统自己猜。

## 明确排除的范围

- **不做任何基于耗时/超时的自动转后台**。这条在设计讨论中被明确否决:系统不该替模型的"前台=依赖当前结果"这个选择做二次判断,自动转后台会让模型在下一步需要答案时却拿到一句"已转后台",破坏调用契约。
- **headless 模式不支持**——没有交互式按键输入,这个功能对 headless 天然无意义。
- **不做"选择要转哪个"的 UI**。前台可能同时有多个(如 `Agent` 的 `tasks` 数组并行派发了几个都没传 `background`),Ctrl+B 按一次把当前回合内所有仍在前台跑着的调用一起转,不引入选择列表。

## 设计方案

### 组件 1:Bash 前台命令 → processManager 过继

现状(`src/tools/exec_shell.ts`):前台路径 spawn 一个 child,包进一个 Promise,靠 `close` 事件 resolve;`ctx.signal` 挂了 abort 监听,负责在中断/超时时杀整个进程组。

改动:
- `processManager`(`src/tools/process_manager.ts`)新增 `adopt(child, meta)` API,区别于现有的 `start()`(重新 spawn)——把一个**已经在跑**的 child 连同已经攒下的 stdout/stderr buffer 一并接管进它的追踪表,复用现有的 `BashOutput`/`KillShell` 读取与终止逻辑。
- Ctrl+B 触发时,若当前有前台 Bash 调用正处在这条路径里:调用 `processManager.adopt(...)` 接管 child,把原来那个前台 Promise 提前 resolve 成"已转后台(id=xxx)"文本(格式对齐现有 `background:true` 的返回文案,`exec_shell.ts:248` 附近)。
- Race 处理:child 可能恰好在同一时刻自然 `close`——用一个"已敲定"标志位保证只 resolve 一次,不会去 adopt 一个已经退出的进程。
- 若前台调用带了显式 `timeout` 参数,过继后要清掉对应的定时器,避免过继完还被原超时机制杀掉。

### 组件 2:Agent 前台调用 → 清理重启(对标 Claude Code)

现状(`src/tools/agent.ts` + `src/agent/runAgent.ts`):前台路径是内联 `for await (const m of runAgent(...))`,被父级 `runAgent` 主循环同步 await,没有中途摘出的信号。

改动方案(对标 CC `AgentTool.tsx:897-1052` 的真实实现,不做"热摘出同一个生成器"这种无先例的复杂机制):
- Ctrl+B 触发时,对正在前台跑的这个 `runAgent()` async iterator 调 `.return(undefined)` 优雅结束消费(不真正中止底层请求,只是父级不再等它继续 yield)。
- 取已经产出的 `sub.messages` 作为进度存档,用这份消息重新发起一个 `isAsync:true` 的 `runAgent()` 调用,挂到已有的异步子代理生命周期(`taskManager.registerAsyncAgent` + `runAsyncAgentLifecycle`)上继续跑。
- 原前台调用处立即返回合成的"已转后台,完成后通知你"文本。
- 代价(与 CC 一致、接受):触发那一刻如果子代理正卡在一次 `streamChat` 请求或一次工具调用的中途,这部分会被放弃,下一轮从上一条完整消息重新开始。
- 并行 `tasks` 数组场景:一次 Ctrl+B 对当前批次里所有仍在前台跑着的都做同样处理。

### 组件 3:公共基础设施——"当前前台调用"注册表

两条机制都依赖同一个前置能力:UI 层需要知道"现在有哪些前台调用正卡着"。

- `App.tsx`(或其等价的顶层运行时状态)维护一个轻量注册表(Set/Map):每个前台 Bash/Agent 调用开始时注册一个"转后台"回调,结束时反注册。
- Ctrl+B 按下时,遍历这个注册表,对每一项调用其"转后台"回调(对应组件 1 或组件 2 的逻辑)。
- 这个注册表与 ESC 使用的顶层 `AbortController`(`App.tsx:526`,整回合粒度)是两套独立机制,互不影响——ESC 保持现有语义不变,Ctrl+B 是新增的、更细粒度的操作。

### 用户反馈

按下 Ctrl+B 那一刻,UI 给一条即时确认(如状态栏一行"已转后台"),不是熔断跳闸那种警告式 `events.notice`——这是用户自己发起的操作,是确认,不是系统单方面的意外通知。

## 边界情况

- 没有前台调用在跑时按 Ctrl+B:无操作,不报错(参考 ESC 在无活跃回合时的行为)。
- 本来就 `background:true` 启动的 Bash/Agent 调用:压根不在这个注册表里,天然跳过,不受影响。
- headless 模式:无按键输入,功能不生效,不需要额外判断逻辑。

## 测试策略

- **Bash 侧**:单元测试 mock 一个不会自然结束的 child 进程,触发转后台回调,断言 `processManager` 收到了这个 child(能通过 `BashOutput` 查询到)、原 Promise resolve 成预期的"已转后台"文本、不会因为 child 后续正常退出而重复 resolve。
- **Agent 侧**:单元测试 mock 一个不会结束的 async generator,触发转后台回调,断言 `.return()` 被调用、`taskManager.registerAsyncAgent` 被调用且带上了已产出的消息、前台调用处返回合成的"已转后台"结果。
- **UI 侧**:Ink 测试用 `stdin.write` 模拟 Ctrl+B 按键,断言:(a) 有前台调用时正确触发转后台并显示确认;(b) 无前台调用时无操作;(c) 多个并行前台调用时全部一起转。
