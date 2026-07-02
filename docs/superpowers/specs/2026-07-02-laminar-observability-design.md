# 用 Laminar 观测 DAO 运行 —— 设计文档

日期:2026-07-02
状态:设计已定,待实现

## 目标

用自托管的 [Laminar](https://laminar.sh)(本地 Docker)对 DAO 做**全链路 trace**:
一次用户请求 → 每次模型调用 → 每个工具执行 → 子代理回合 → 记忆
reflect/distill/consolidate,形成可在 Laminar UI 里下钻的调用树,附带
model / token / cache 命中 / 时延 等指标。

## 关键前提(决定整体做法)

DAO 通过**单一原语** `streamChat()`(`src/client/client.ts`)对 DeepSeek 的
`/chat/completions` 发起 **raw `fetch`**,不经 OpenAI/Anthropic/Vercel-AI 任何 SDK。

因此 Laminar 招牌的"1 行自动埋点"**抓不到 DAO**——它只 hook 已知 LLM SDK。
本设计走**手动埋点**(`Laminar.initialize()` + `observe()` / 手动 span)。

好消息:`streamChat` / `runTurn` / `executeToolCalls` 三者都通过 `deps.xxx`
**依赖注入**贯穿全项目(`loop.ts` / `subagent.ts` / 记忆 `distill`·`consolidate`
·`unified_reflect`)。所以在组合根包一层即可覆盖所有调用路径,核心逻辑文件一行不动。

## 已确认的决策

| 项 | 决策 |
|---|---|
| trace 深度 | 全链路(turn → llm → tool → subagent → memory) |
| 后端 | 本地 Docker 自托管,数据不出机器 |
| 埋点架构 | 方案 A:组合根统一包装,新增 `src/obs/`,核心文件不动 |
| 依赖方式 | `optionalDependencies` + `await import()` 动态加载 |
| 开关 | CLI flag `dao --obs`(主),默认关闭;未开=noop 零开销。密钥/地址走 env(`LMNR_PROJECT_API_KEY` / `LMNR_BASE_URL`) |

## 权威 API(已从 lmnr-ts 源码核实)

- `Laminar.initialize({ projectApiKey, baseUrl, httpPort, grpcPort, instrumentModules })`
  - 自托管:`baseUrl: "http://localhost"`, `httpPort: 8000`, `grpcPort: 8001`(或 `LMNR_BASE_URL` 环境变量)
- `observe({ name, spanType, input, metadata, sessionId, tags }, fn, ...args)`
  - `spanType: 'DEFAULT' | 'LLM' | 'TOOL' | 'EVALUATOR' | 'EVALUATION' | 'EXECUTOR'`
- `Laminar.setSpanAttributes(attrs)` —— LLM span 内手动写 model/token(见下表)
- `Laminar.setTraceSessionId(id)` / `Laminar.setSpanTags(tags)`
- `await Laminar.flush()` / `await Laminar.shutdown()` —— 退出前 flush
- `LaminarAttributes` 关键键:
  - `REQUEST_MODEL = "gen_ai.request.model"`
  - `INPUT_TOKEN_COUNT = "gen_ai.usage.input_tokens"`
  - `OUTPUT_TOKEN_COUNT = "gen_ai.usage.output_tokens"`
  - `TOTAL_TOKEN_COUNT = "llm.usage.total_tokens"`

## 组件设计

### 模块布局(唯一新增目录)

```
src/obs/
  init.ts    // initObs(): 动态 import + Laminar.initialize + 注册退出 flush;未开则 noop
  wrap.ts    // wrapStreamChat / wrapRunTurn / wrapToolExec
  attrs.ts   // DAO Usage → LaminarAttributes 映射(含 cache 命中标记)
  index.ts   // 统一导出;所有导出在未初始化时降级为 noop/透传
```

设计边界:
- `init.ts`:只负责"起没起、往哪送、退出 flush"。对外暴露 `isObsOn()`。
- `wrap.ts`:三个纯包装器,输入原函数、输出同签名函数;`--obs` 未开时(`isObsOn()` 为 false)**原样返回入参函数**。
- `attrs.ts`:把 DAO 的 `Usage`(现成 `onUsage` 回调的类型)翻译成 Laminar 属性对象,单元可测,无副作用。
- 三者都不 import 核心 loop/client,仅被 `index.ts`(组合根)调用 → 无循环依赖。

### 初始化与开关(`src/index.ts` 启动最早处)

开关走 CLI flag,贴合现有解析惯例(`src/index.ts:194` 的 `rawArgs.includes("--goal")` 同款):
- 判 `const OBS = rawArgs.includes("--obs")`;
- 把 `"--obs"` 加进现有的 `flags` Set(`src/index.ts:202`),防止被当 prompt 拼接;
- `await initObs(OBS)` 传入。

```ts
await initObs(rawArgs.includes("--obs")); // false 时立即 return,不 import lmnr
```

`initObs()` 伪代码:
```ts
export async function initObs(on: boolean) {
  if (!on) return;
  const { Laminar } = await import("@lmnr-ai/lmnr"); // optionalDependency
  Laminar.initialize({
    projectApiKey: process.env.LMNR_PROJECT_API_KEY,
    baseUrl: process.env.LMNR_BASE_URL ?? "http://localhost",
    httpPort: 8000,
    grpcPort: 8001,
  });
  registerExitFlush(async () => { await Laminar.flush(); });
}
```

### 三个包装器 + span 属性

在 `index.ts` 组合根,把注入的三个函数各包一层再传下去:

| 包装点 | spanType | span 名 | 关键属性 |
|---|---|---|---|
| `wrapStreamChat(streamChat)` | `LLM` | `llm.call` | `REQUEST_MODEL`;`INPUT/OUTPUT/TOTAL_TOKEN_COUNT`(取自 `onUsage`,含 cache 命中);input=messages;output=最终 assistant 文本;tags=`cache_hit`/`cache_miss` |
| `wrapRunTurn(runTurn)` | `DEFAULT` | `turn` | `setTraceSessionId(sessionId)`;metadata: agent 身份(main/sub/bg/fork)、depth |
| `wrapToolExec(executeToolCalls)` | `TOOL` | `tool.<name>` | 每工具一子 span:name、args(截断)、result 摘要、duration |

层级自然形成:
```
turn
 ├─ llm.call (model / tokens / cache_hit / latency / prompt / completion)
 ├─ tool.read_file (args / result / duration)
 ├─ tool.edit
 └─ subagent.turn → (递归同结构)
```
记忆 `distill` / `consolidate` / `unified_reflect` 因为也走注入的 `streamChat`,
**自动被 `llm.call` span 覆盖**,无需单独埋点。

### ⚠️ 关键技术点:streamChat 是 async generator

`observe()` 适配 `async () => value`;但 `streamChat` 是
`AsyncGenerator<StreamDelta, AssistantMessage>`,调用方用 `for await` 消费,
最终返回值 `AssistantMessage` 从 generator 的 `return` 出。

直接 `observe` 包 generator 会在**拿到迭代器那一刻**就结束 span,token/output 全部丢失。

**对策:`wrapStreamChat` 手动管理 span,不用 observe:**
```ts
export function wrapStreamChat(inner) {
  if (!isObsOn()) return inner;
  return async function* (opts) {
    const span = startLlmSpan("llm.call", opts.messages);
    let usage; 
    const origOnUsage = opts.onUsage;
    const patched = { ...opts, onUsage: (u) => { usage = u; origOnUsage?.(u); } };
    try {
      const msg = yield* inner(patched);      // 透传所有 delta
      setSpanAttributes(toAttrs(opts.model, usage)); // 迭代结束后写 token
      setSpanOutput(span, msg.content);
      return msg;
    } finally {
      endSpan(span);
    }
  };
}
```
要点:
- 用 patched `onUsage` 截获 usage(不破坏原回调链)。
- `yield*` 透传 delta,不改变对调用方的流式契约。
- token/output 在迭代**结束后**写入,span 在 `finally` 关闭(abort/异常也正确收尾)。

这是本设计**唯一有实现难度**的地方,plan 里单列步骤 + 专项测试。

### 退出 flush(TUI 长驻,必须)

DAO 是 Ink 长驻进程,span 批量导出。进程正常退出 / SIGINT(ESC 退出)时
必须 `await Laminar.flush()`,否则最后一批 trace 丢。挂到现有退出清理路径
(`registerExitFlush`),不新造退出机制。

### Bun `--compile` 风险与对策

`@lmnr-ai/lmnr` 依赖大量 OTel Node 专有能力,`bun build --compile`(DAO 的
`bundle` 脚本)可能打不进去。

对策:
- 观测**默认路径**走 `npm run dev`(tsx)/ `node dist`,这条路径确定可用。
- 二进制里未加 `--obs` → `initObs()` 直接 return,**永不 import lmnr**,
  即使编译期没带上依赖也不影响主功能。
- "编译二进制能否带观测"列为 plan 里一个**独立验证 spike**,不阻塞主线。

## 自托管 Docker 起法(文档化)

```bash
git clone https://github.com/lmnr-ai/lmnr
cd lmnr
docker compose up -d
```

端口(来自官方 docker-compose):
- 前端 UI:`http://localhost:5667` —— 注册账号、建 project、拿 project API key
- ingest / API:`8000`(HTTP)、`8001`(gRPC)

配置 DAO(密钥设一次,`--obs` 想看就加):
```bash
export LMNR_PROJECT_API_KEY=<从 localhost:5667 project settings 复制>
export LMNR_BASE_URL=http://localhost   # 可选,默认即此

npm run dev -- --obs "帮我重构这个函数"   # 开发路径(推荐,确定带观测)
# 或 node dist/index.js --obs
# 不加 --obs = 完全关闭,连 lmnr 都不 import
```

写进 `README` 或 `docs/` 的"观测"章节。

## 错误处理

- lmnr import 失败(未装 optionalDependency)→ `initObs()` catch 后走 noop,打一行 warn,不崩主流程。
- Laminar 初始化/发送失败 → 不得影响 DAO 正常运行;观测是旁路,永远不阻塞主链路。
- flush 超时 → 设上限(如 2s),超时放弃,不卡退出。

## 测试策略

- `src/obs/wrap.test.ts`:mock Laminar
  - `wrapStreamChat` 在迭代**结束后**调用 `setSpanAttributes` 且带正确 token;delta 透传不变;abort 路径也 `endSpan`。
  - `wrapToolExec` 每工具一个 span,名 `tool.<name>`。
  - `--obs` 未开(isObsOn=false)→ 包装器**原样返回**入参函数,零 Laminar 调用。
- `src/obs/attrs.test.ts`:Usage → 属性映射(含 cache 命中标记)。
- 不接真实 Laminar 后端做单测;真实后端联通作为手动验收(docker 起后跑一次 dao,UI 看到 trace)。

## YAGNI(明确不做)

- 不做 Laminar 的 evaluation / dataset 功能(只做 tracing)。
- 不做云端后端支持(本次只自托管;但 `LMNR_BASE_URL` 已留口,日后指向云端即可)。
- 不改 `streamChat` / `loop` / 工具执行器的任何核心逻辑。
- 暂不保证 bun 二进制带观测(列为 spike)。

## 未决/后续

- ~~bun `--compile` 能否携带 lmnr~~ **已验证(2026-07-02,scenario 1=支持)**:`npm run bundle` 成功(2004 modules,含 `@lmnr-ai/lmnr` + `@opentelemetry/*`);编译二进制 `./dao --obs` 设 `LMNR_PROJECT_API_KEY` 后 `Laminar.initialize()` 无报错、lmnr 正常加载。即**二进制路径也支持观测**,不限 dev/node。端到端出 trace 仍需后端联通复核(Step 8)。
- Minor(待优化):`Laminar.initialize()` 在 `projectApiKey` 为空时会**自己抛错**,被 init.ts 的 catch 降级(旁路铁律成立),但导致 init.ts 里「未设 LMNR_PROJECT_API_KEY」友好提示不可达、被 lmnr 冗长报错取代。可改为在 initialize 前先查 key:无 key 则打友好提示并跳过初始化。
- Minor(final triage 遗留):组合根 `as unknown as Parameters<typeof wrapToolExec>[0]` cast(更干净解=wrap.ts 的 `ToolExecFn` 三个 `unknown` 换成 type-only import 的 `ToolRegistry`/`ToolContext`/`ApprovalGate`);cache 命中当前写成 association property 而非 span tag,待 UI 目视确认呈现。
