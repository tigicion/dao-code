# Laminar 全链路观测 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 DAO 加一条默认关闭的旁路观测,`dao --obs` 开启后把「用户回合 → 每次模型调用 → 每个工具执行 → 子代理」全链路 span 上报到本地自托管 Laminar。

**Architecture:** 新增 `src/obs/` 模块,通过一个后端 seam(`ObsBackend` 接口)隔离 Laminar SDK。核心文件不改逻辑,只在 `src/index.ts` 组合根把注入的 `streamChat`/`runTurn`/`executeToolCalls` 各包一层。`--obs` 未开时后端为 null,所有包装器原样透传,连 `@lmnr-ai/lmnr` 都不 import。

**Tech Stack:** TypeScript(ESM)、vitest、`@lmnr-ai/lmnr`(optionalDependency,动态 import)、本地 Docker 自托管 Laminar。

## Global Constraints

- 观测是**旁路**:任何观测代码失败都不得影响 DAO 主链路(初始化/发送/flush 失败都 catch 后降级)。
- `--obs` 未开时**零开销、零 import**:不加载 `@lmnr-ai/lmnr`。
- 依赖走 `optionalDependencies` + `await import()`;不进 `dependencies`,不撑大发布包。
- 不改 `src/client/client.ts`、`src/agent/loop.ts`、`src/tools/execute.ts` 的任何**核心逻辑**(仅 index.ts 组合根做包装接线)。
- Laminar 权威 API(已核实):`Laminar.initialize({projectApiKey, baseUrl, httpPort, grpcPort})`;`Laminar.startSpan({name, input, spanType, sessionId, metadata}): Span`(返回 OTel `Span`,用 `span.setAttributes(obj)` 写属性、`span.end()` 收尾);`Laminar.withSpan(span, fn, endOnExit?)` 让 span 成为活跃父上下文;`await Laminar.flush()`。
- LaminarAttributes 键(字符串常量):`REQUEST_MODEL="gen_ai.request.model"`、`INPUT_TOKEN_COUNT="gen_ai.usage.input_tokens"`、`OUTPUT_TOKEN_COUNT="gen_ai.usage.output_tokens"`、`TOTAL_TOKEN_COUNT="llm.usage.total_tokens"`;span 输出属性键 `"lmnr.span.output"`。
- DAO `Usage` 类型(`src/client/types.ts`):`{prompt_tokens, completion_tokens, total_tokens, prompt_cache_hit_tokens?, prompt_cache_miss_tokens?}`。

---

## File Structure

```
src/obs/
  backend.ts   // ObsBackend/ObsSpan 接口 + 模块级 backend 单例 + isObsOn/getBackend/setBackend + registerExitFlush
  attrs.ts     // Usage → LLM span 属性对象;cacheTag(Usage) → "cache_hit"|"cache_miss"|undefined
  wrap.ts      // wrapStreamChat / wrapRunTurn / wrapToolExec(仅依赖 backend.ts,不 import lmnr)
  init.ts      // initObs(on):动态 import lmnr、建 Laminar 适配器、setBackend、注册退出 flush
  index.ts     // barrel:re-export 上述公开 API
src/obs/attrs.test.ts
src/obs/wrap.test.ts
src/obs/init.test.ts
```

依赖方向:`wrap.ts → backend.ts`、`attrs.ts`(纯);`init.ts → backend.ts`(+ 动态 import lmnr);`index.ts(项目根)→ obs/index.ts`。obs 模块**不** import 任何核心 loop/client/tools 文件 → 无循环依赖。

---

### Task 1: `attrs.ts` —— Usage → 属性映射(纯函数)

**Files:**
- Create: `src/obs/attrs.ts`
- Test: `src/obs/attrs.test.ts`

**Interfaces:**
- Consumes: `Usage` from `../client/types.js`
- Produces:
  - `llmAttributes(model: string, usage?: Usage): Record<string, number | string>` — 返回带 `gen_ai.request.model` 与 token 计数的属性对象;`usage` 缺省时只含 model。
  - `cacheTag(usage?: Usage): "cache_hit" | "cache_miss" | undefined` — 有 `prompt_cache_hit_tokens>0` → `cache_hit`;有 miss 字段且 hit 为 0 → `cache_miss`;都没有 → `undefined`。

- [ ] **Step 1: 写失败测试**

`src/obs/attrs.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { llmAttributes, cacheTag } from "./attrs.js";
import type { Usage } from "../client/types.js";

describe("llmAttributes", () => {
  it("含 model 且无 usage 时只写 model", () => {
    expect(llmAttributes("deepseek-chat")).toEqual({
      "gen_ai.request.model": "deepseek-chat",
    });
  });
  it("有 usage 时写全 token 计数", () => {
    const u: Usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
    expect(llmAttributes("m", u)).toEqual({
      "gen_ai.request.model": "m",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20,
      "llm.usage.total_tokens": 120,
    });
  });
});

describe("cacheTag", () => {
  it("hit>0 → cache_hit", () => {
    expect(cacheTag({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, prompt_cache_hit_tokens: 50 })).toBe("cache_hit");
  });
  it("hit=0 且有 miss → cache_miss", () => {
    expect(cacheTag({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 30 })).toBe("cache_miss");
  });
  it("无 cache 字段 → undefined", () => {
    expect(cacheTag({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })).toBeUndefined();
  });
  it("undefined usage → undefined", () => {
    expect(cacheTag(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/obs/attrs.test.ts`
Expected: FAIL —— `Cannot find module './attrs.js'`。

- [ ] **Step 3: 写实现**

`src/obs/attrs.ts`:
```ts
import type { Usage } from "../client/types.js";

// LaminarAttributes 键(与 @lmnr-ai/lmnr 的 gen_ai/llm 语义约定一致)。
const REQUEST_MODEL = "gen_ai.request.model";
const INPUT_TOKENS = "gen_ai.usage.input_tokens";
const OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
const TOTAL_TOKENS = "llm.usage.total_tokens";

/** 把一次 LLM 调用的 model + usage 翻成 Laminar LLM span 属性对象。 */
export function llmAttributes(model: string, usage?: Usage): Record<string, number | string> {
  const attrs: Record<string, number | string> = { [REQUEST_MODEL]: model };
  if (usage) {
    attrs[INPUT_TOKENS] = usage.prompt_tokens;
    attrs[OUTPUT_TOKENS] = usage.completion_tokens;
    attrs[TOTAL_TOKENS] = usage.total_tokens;
  }
  return attrs;
}

/** DeepSeek 扁平 cache 字段 → span tag;无信息则 undefined。 */
export function cacheTag(usage?: Usage): "cache_hit" | "cache_miss" | undefined {
  if (!usage) return undefined;
  if ((usage.prompt_cache_hit_tokens ?? 0) > 0) return "cache_hit";
  if ((usage.prompt_cache_miss_tokens ?? 0) > 0) return "cache_miss";
  return undefined;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/obs/attrs.test.ts`
Expected: PASS(6 个用例)。

- [ ] **Step 5: 提交**

```bash
git add src/obs/attrs.ts src/obs/attrs.test.ts
git commit -m "feat(obs): Usage→Laminar 属性映射 + cache tag"
```

---

### Task 2: `backend.ts` —— 后端 seam + 退出 flush 注册

**Files:**
- Create: `src/obs/backend.ts`
- Test: `src/obs/backend.test.ts`

**Interfaces:**
- Produces:
  - `interface ObsSpan { setAttributes(a: Record<string, unknown>): void; end(): void }`
  - `interface ObsBackend { startSpan(o: { name: string; spanType: "LLM"|"TOOL"|"DEFAULT"; input?: unknown; sessionId?: string; metadata?: Record<string, unknown> }): ObsSpan; withActive<T>(span: ObsSpan, fn: () => T): T; flush(): Promise<void> }`
  - `setBackend(b: ObsBackend | null): void`
  - `getBackend(): ObsBackend | null`
  - `isObsOn(): boolean`(= `getBackend() !== null`)
  - `registerExitFlush(flush: () => Promise<void>): void` —— 幂等注册 `process.on("exit"/"SIGINT"/"SIGTERM")` 时的 flush(带 2s 超时,不卡退出)。

- [ ] **Step 1: 写失败测试**

`src/obs/backend.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { setBackend, getBackend, isObsOn } from "./backend.js";
import type { ObsBackend } from "./backend.js";

const fake: ObsBackend = {
  startSpan: () => ({ setAttributes() {}, end() {} }),
  withActive: (_s, fn) => fn(),
  flush: async () => {},
};

describe("backend 单例", () => {
  beforeEach(() => setBackend(null));
  it("默认关闭:getBackend null、isObsOn false", () => {
    expect(getBackend()).toBeNull();
    expect(isObsOn()).toBe(false);
  });
  it("setBackend 后开启", () => {
    setBackend(fake);
    expect(getBackend()).toBe(fake);
    expect(isObsOn()).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/obs/backend.test.ts`
Expected: FAIL —— `Cannot find module './backend.js'`。

- [ ] **Step 3: 写实现**

`src/obs/backend.ts`:
```ts
export interface ObsSpan {
  setAttributes(attrs: Record<string, unknown>): void;
  end(): void;
}

export interface ObsBackend {
  startSpan(opts: {
    name: string;
    spanType: "LLM" | "TOOL" | "DEFAULT";
    input?: unknown;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  }): ObsSpan;
  /** 让 span 成为活跃父上下文,fn 执行期间新建的 span 都挂它下面。 */
  withActive<T>(span: ObsSpan, fn: () => T): T;
  flush(): Promise<void>;
}

let backend: ObsBackend | null = null;

export function setBackend(b: ObsBackend | null): void {
  backend = b;
}
export function getBackend(): ObsBackend | null {
  return backend;
}
export function isObsOn(): boolean {
  return backend !== null;
}

let exitHookInstalled = false;
/** 注册退出时 flush(幂等)。flush 最多等 2s,超时放弃,绝不卡退出。 */
export function registerExitFlush(flush: () => Promise<void>): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const run = () => {
    void Promise.race([
      flush(),
      new Promise((r) => setTimeout(r, 2000)),
    ]).catch(() => {});
  };
  process.on("exit", run);
  process.on("SIGINT", run);
  process.on("SIGTERM", run);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/obs/backend.test.ts`
Expected: PASS(2 个用例)。

- [ ] **Step 5: 提交**

```bash
git add src/obs/backend.ts src/obs/backend.test.ts
git commit -m "feat(obs): 后端 seam(ObsBackend)+ 退出 flush 注册"
```

---

### Task 3: `wrap.ts` —— 三个包装器

**Files:**
- Create: `src/obs/wrap.ts`
- Test: `src/obs/wrap.test.ts`

**Interfaces:**
- Consumes: `getBackend`/`ObsBackend`/`ObsSpan` from `./backend.js`;`llmAttributes`/`cacheTag` from `./attrs.js`;类型 `StreamChatOptions`/`StreamDelta`/`AssistantMessage`/`ToolCall`/`ToolMessage` from `../client/types.js`。
- Produces:
  - `wrapStreamChat(inner)` —— 入出同为 `(opts: StreamChatOptions) => AsyncGenerator<StreamDelta, AssistantMessage>`。
  - `wrapRunTurn(inner)` —— 入出同为 `(deps: any) => Promise<void>`;从 `deps.sessionId`/`deps.identity`/`deps.depth` 取 metadata(缺省容错)。
  - `wrapToolExec(inner)` —— 入出同为 `(toolCalls: ToolCall[], registry, ctx, gate) => Promise<ToolMessage[]>`。
  - 三者在 `getBackend() === null` 时**原样返回入参函数**(引用相等)。

关键点(来自 spec):`streamChat` 是 async generator,不能用会提前收尾的包装;手动 `startSpan → yield* 透传 → 迭代结束写 token/output → finally end`。token 通过 patch `opts.onUsage` 截获,不破坏原回调链。

- [ ] **Step 1: 写失败测试**

`src/obs/wrap.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setBackend } from "./backend.js";
import type { ObsBackend, ObsSpan } from "./backend.js";
import { wrapStreamChat, wrapRunTurn, wrapToolExec } from "./wrap.js";
import type { StreamChatOptions, AssistantMessage, StreamDelta, ToolCall, ToolMessage } from "../client/types.js";

// 记录型 fake:每个 span 记 attrs 与 end 调用。
function makeFake() {
  const spans: { name: string; spanType: string; input?: unknown; attrs: Record<string, unknown>; ended: boolean }[] = [];
  const backend: ObsBackend = {
    startSpan(o) {
      const rec = { name: o.name, spanType: o.spanType, input: o.input, attrs: {} as Record<string, unknown>, ended: false };
      spans.push(rec);
      const span: ObsSpan = {
        setAttributes(a) { Object.assign(rec.attrs, a); },
        end() { rec.ended = true; },
      };
      return span;
    },
    withActive: (_s, fn) => fn(),
    flush: async () => {},
  };
  return { backend, spans };
}

// 一个最小 streamChat:yield 两个 delta,回调 usage,return 最终消息。
async function* fakeStream(opts: StreamChatOptions): AsyncGenerator<StreamDelta, AssistantMessage> {
  yield { kind: "content", text: "he" };
  yield { kind: "content", text: "llo" };
  opts.onUsage?.({ prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_cache_hit_tokens: 80 });
  return { role: "assistant", content: "hello" } as AssistantMessage;
}

const baseOpts = (): StreamChatOptions => ({ baseUrl: "x", apiKey: "x", model: "deepseek-chat", messages: [] });

describe("wrapStreamChat", () => {
  beforeEach(() => setBackend(null));

  it("关闭时原样返回入参函数(引用相等)", () => {
    expect(wrapStreamChat(fakeStream)).toBe(fakeStream);
  });

  it("开启时:delta 全透传、迭代结束后写 token/model/output、span 收尾", async () => {
    const { backend, spans } = makeFake();
    setBackend(backend);
    const usageSpy = vi.fn();
    const gen = wrapStreamChat(fakeStream)({ ...baseOpts(), onUsage: usageSpy });
    const deltas: StreamDelta[] = [];
    let res = await gen.next();
    while (!res.done) { deltas.push(res.value); res = await gen.next(); }
    const final = res.value as AssistantMessage;

    expect(deltas.map((d) => (d as any).text).join("")).toBe("hello"); // 透传不变
    expect(final.content).toBe("hello");                                // 原回调链保留
    expect(usageSpy).toHaveBeenCalledOnce();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("llm.call");
    expect(spans[0].spanType).toBe("LLM");
    expect(spans[0].attrs["gen_ai.request.model"]).toBe("deepseek-chat");
    expect(spans[0].attrs["gen_ai.usage.input_tokens"]).toBe(100);
    expect(spans[0].attrs["llm.span.output" in spans[0].attrs ? "llm.span.output" : "lmnr.span.output"]).toBe("hello");
    expect(spans[0].ended).toBe(true);
  });

  it("迭代中途异常也 end span", async () => {
    const { backend, spans } = makeFake();
    setBackend(backend);
    async function* boom(): AsyncGenerator<StreamDelta, AssistantMessage> {
      yield { kind: "content", text: "x" };
      throw new Error("boom");
    }
    const gen = wrapStreamChat(boom as any)(baseOpts());
    await gen.next();
    await expect(gen.next()).rejects.toThrow("boom");
    expect(spans[0].ended).toBe(true);
  });
});

describe("wrapToolExec", () => {
  beforeEach(() => setBackend(null));
  const tc = (id: string, name: string): ToolCall => ({ id, type: "function", function: { name, arguments: "{}" } });

  it("关闭时原样返回", () => {
    const inner = async () => [];
    expect(wrapToolExec(inner as any)).toBe(inner);
  });

  it("每个工具一个 TOOL span,名 tool.<name>,按 id 配结果并收尾", async () => {
    const { backend, spans } = makeFake();
    setBackend(backend);
    const inner = async (calls: ToolCall[]): Promise<ToolMessage[]> =>
      calls.map((c) => ({ role: "tool", tool_call_id: c.id, content: `result-${c.id}` }));
    const out = await wrapToolExec(inner as any)([tc("a", "read_file"), tc("b", "edit")], {} as any, {} as any, {} as any);
    expect(out).toHaveLength(2);
    expect(spans.map((s) => s.name).sort()).toEqual(["tool.edit", "tool.read_file"]);
    expect(spans.every((s) => s.spanType === "TOOL" && s.ended)).toBe(true);
  });
});

describe("wrapRunTurn", () => {
  beforeEach(() => setBackend(null));
  it("关闭时原样返回", () => {
    const inner = async () => {};
    expect(wrapRunTurn(inner as any)).toBe(inner);
  });
  it("开启时建 turn span 并在 withActive 中执行 inner", async () => {
    const { backend, spans } = makeFake();
    setBackend(backend);
    let ran = false;
    await wrapRunTurn((async () => { ran = true; }) as any)({ sessionId: "s1" });
    expect(ran).toBe(true);
    expect(spans[0].name).toBe("turn");
    expect(spans[0].spanType).toBe("DEFAULT");
    expect(spans[0].ended).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/obs/wrap.test.ts`
Expected: FAIL —— `Cannot find module './wrap.js'`。

- [ ] **Step 3: 写实现**

`src/obs/wrap.ts`:
```ts
import { getBackend, type ObsSpan } from "./backend.js";
import { llmAttributes, cacheTag } from "./attrs.js";
import type {
  StreamChatOptions, StreamDelta, AssistantMessage, ToolCall, ToolMessage, Usage,
} from "../client/types.js";

const SPAN_OUTPUT = "lmnr.span.output"; // Laminar 约定的 span 输出属性键

function truncate(s: string, n = 2000): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

type StreamFn = (opts: StreamChatOptions) => AsyncGenerator<StreamDelta, AssistantMessage>;

/** LLM span:generator 手动管 span,迭代结束后写 token/output(不能用 observe,否则提前收尾)。 */
export function wrapStreamChat(inner: StreamFn): StreamFn {
  if (!getBackend()) return inner;
  return async function* (opts: StreamChatOptions): AsyncGenerator<StreamDelta, AssistantMessage> {
    const backend = getBackend();
    if (!backend) return yield* inner(opts); // 运行中被关(极边界):直接透传
    const span: ObsSpan = backend.startSpan({
      name: "llm.call", spanType: "LLM", input: opts.messages,
    });
    let usage: Usage | undefined;
    const orig = opts.onUsage;
    const patched: StreamChatOptions = {
      ...opts,
      onUsage: (u) => { usage = u; orig?.(u); }, // 截获 usage,不破坏原回调链
    };
    try {
      const msg = yield* inner(patched);          // 透传全部 delta 与返回值
      span.setAttributes(llmAttributes(opts.model, usage));
      const tag = cacheTag(usage);
      if (tag) span.setAttributes({ [`lmnr.association.properties.${tag}`]: 1 });
      span.setAttributes({ [SPAN_OUTPUT]: truncate(msg.content ?? "") });
      return msg;
    } finally {
      span.end();                                 // abort/异常也正确收尾
    }
  };
}

type RunTurnFn = (deps: any) => Promise<void>;

/** turn span:普通 async,用 withActive 让本回合内的 llm/tool span 都挂它下面。 */
export function wrapRunTurn(inner: RunTurnFn): RunTurnFn {
  if (!getBackend()) return inner;
  return async (deps: any): Promise<void> => {
    const backend = getBackend();
    if (!backend) return inner(deps);
    const span = backend.startSpan({
      name: "turn", spanType: "DEFAULT",
      sessionId: typeof deps?.sessionId === "string" ? deps.sessionId : undefined,
      metadata: {
        identity: deps?.identity ?? "main",
        depth: typeof deps?.depth === "number" ? deps.depth : 0,
      },
    });
    try {
      await backend.withActive(span, () => inner(deps));
    } finally {
      span.end();
    }
  };
}

type ToolExecFn = (
  toolCalls: ToolCall[], registry: unknown, ctx: unknown, gate: unknown,
) => Promise<ToolMessage[]>;

/** 每个 tool_call 一个 TOOL span;批量 await 后按 tool_call_id 配结果。
 *  注:工具在 executeToolCalls 内部并发/屏障执行,duration 为批级近似(不改核心文件的取舍)。 */
export function wrapToolExec(inner: ToolExecFn): ToolExecFn {
  if (!getBackend()) return inner;
  return async (toolCalls, registry, ctx, gate): Promise<ToolMessage[]> => {
    const backend = getBackend();
    if (!backend) return inner(toolCalls, registry, ctx, gate);
    const spans = new Map<string, ObsSpan>();
    for (const tc of toolCalls) {
      spans.set(tc.id, backend.startSpan({
        name: `tool.${tc.function.name}`, spanType: "TOOL",
        input: truncate(tc.function.arguments ?? ""),
      }));
    }
    try {
      const results = await inner(toolCalls, registry, ctx, gate);
      for (const r of results) {
        const span = spans.get(r.tool_call_id);
        if (span) span.setAttributes({ [SPAN_OUTPUT]: truncate(r.content ?? "") });
      }
      return results;
    } finally {
      for (const span of spans.values()) span.end();
    }
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/obs/wrap.test.ts`
Expected: PASS(所有用例)。若 `lmnr.span.output` 断言那行报错,把测试里那句改成直接读 `spans[0].attrs["lmnr.span.output"]`(实现固定用该键)。

- [ ] **Step 5: 提交**

```bash
git add src/obs/wrap.ts src/obs/wrap.test.ts
git commit -m "feat(obs): streamChat/runTurn/toolExec 三包装器 + 关闭态透传"
```

---

### Task 4: `init.ts` + `index.ts`(barrel)—— Laminar 适配器与初始化

**Files:**
- Create: `src/obs/init.ts`
- Create: `src/obs/index.ts`
- Test: `src/obs/init.test.ts`

**Interfaces:**
- Consumes: `setBackend`/`registerExitFlush`/`ObsBackend`/`ObsSpan` from `./backend.js`。
- Produces:
  - `initObs(on: boolean): Promise<void>` —— `on=false` 直接 return(不 import lmnr);`on=true` 动态 import `@lmnr-ai/lmnr`、`Laminar.initialize`、构造 `ObsBackend` 适配器、`setBackend`、`registerExitFlush`。任何异常 catch 后 warn 降级(不 setBackend)。
  - `src/obs/index.ts` re-export:`initObs`、`isObsOn`、`wrapStreamChat`、`wrapRunTurn`、`wrapToolExec`。

- [ ] **Step 1: 写失败测试**

`src/obs/init.test.ts`(只测「关闭时不 import、不开后端」这条确定行为;真实 lmnr 联通留手动验收):
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { initObs } from "./init.js";
import { isObsOn, setBackend } from "./backend.js";

describe("initObs 关闭路径", () => {
  beforeEach(() => setBackend(null));
  it("on=false 时不开启后端(也不 import lmnr)", async () => {
    await initObs(false);
    expect(isObsOn()).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/obs/init.test.ts`
Expected: FAIL —— `Cannot find module './init.js'`。

- [ ] **Step 3: 写实现**

`src/obs/init.ts`:
```ts
import { setBackend, registerExitFlush, type ObsBackend, type ObsSpan } from "./backend.js";

/** 开启观测:动态 import Laminar、初始化、装配 ObsBackend 适配器、注册退出 flush。
 *  失败一律降级为「未开启」,绝不影响主链路。 */
export async function initObs(on: boolean): Promise<void> {
  if (!on) return; // 关闭:不 import lmnr,零开销
  try {
    // @ts-expect-error optionalDependency,未安装时由 catch 兜底
    const { Laminar } = await import("@lmnr-ai/lmnr");
    Laminar.initialize({
      projectApiKey: process.env.LMNR_PROJECT_API_KEY,
      baseUrl: process.env.LMNR_BASE_URL ?? "http://localhost",
      httpPort: Number(process.env.LMNR_HTTP_PORT) || 8000,
      grpcPort: Number(process.env.LMNR_GRPC_PORT) || 8001,
    });
    const backend: ObsBackend = {
      startSpan(o) {
        const span = Laminar.startSpan({
          name: o.name, input: o.input, spanType: o.spanType,
          sessionId: o.sessionId, metadata: o.metadata,
        });
        const obs: ObsSpan = {
          setAttributes: (a) => span.setAttributes(a as Record<string, string | number>),
          end: () => span.end(),
        };
        return obs;
      },
      withActive: (span, fn) => {
        // ObsSpan 是适配壳;真实 withSpan 需要底层 Laminar Span。见下方说明。
        return fn();
      },
      flush: () => Laminar.flush(),
    };
    setBackend(backend);
    registerExitFlush(() => Laminar.flush());
    if (!process.env.LMNR_PROJECT_API_KEY) {
      process.stderr.write("[obs] 已开启但未设 LMNR_PROJECT_API_KEY,trace 可能无法入库\n");
    }
  } catch (e) {
    process.stderr.write(`[obs] 初始化失败,已降级为关闭:${(e as Error).message}\n`);
    // 不 setBackend → isObsOn() 仍为 false → 包装器全透传
  }
}
```

> **实现说明(withActive 的父子嵌套):** 上面的 `withActive` 简化为直接执行 `fn`,turn 与其子 span 会落在同一 trace 但可能平级而非嵌套。要拿到 spec 里的**嵌套树**,`ObsBackend.startSpan` 需保留底层 Laminar `Span` 引用,`withActive` 改调 `Laminar.withSpan(rawSpan, fn)`。落地方式:把 `ObsSpan` 扩一个内部字段存 raw span(仅 init 适配器读),`withActive` 取出后 `Laminar.withSpan(raw, fn)`。此细节在真实 docker 联通(Step 6)时按 UI 实际层级验证并定稿;先用简化版跑通链路。

`src/obs/index.ts`:
```ts
export { initObs } from "./init.js";
export { isObsOn } from "./backend.js";
export { wrapStreamChat, wrapRunTurn, wrapToolExec } from "./wrap.js";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/obs/init.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/obs/init.ts src/obs/index.ts src/obs/init.test.ts
git commit -m "feat(obs): initObs 动态装配 Laminar 适配器 + barrel 导出"
```

---

### Task 5: 接线 `src/index.ts` + `package.json`

**Files:**
- Modify: `src/index.ts`(import 重命名 + 组合根包装 + `--obs` flag + 退出 flush 已由 registerExitFlush 覆盖)
- Modify: `package.json`(加 `optionalDependencies`)

**Interfaces:**
- Consumes: `initObs`/`wrapStreamChat`/`wrapRunTurn`/`wrapToolExec` from `./obs/index.js`。

- [ ] **Step 1: 加 optionalDependency**

`package.json` 顶层加(与 `dependencies` 同级):
```json
  "optionalDependencies": {
    "@lmnr-ai/lmnr": "^0.7.0"
  },
```
然后安装(仅本地开发装,不进普通用户的必装依赖):
```bash
npm install
```
> 版本号以 `npm view @lmnr-ai/lmnr version` 实际最新为准,装完把 `^x.y.z` 回填。

- [ ] **Step 2: 重命名三个 import(供组合根 shadow 包装)**

`src/index.ts:13-15`,改为:
```ts
import { streamChat as streamChatRaw } from "./client/client.js";
import { runTurn as runTurnRaw } from "./agent/loop.js";
import { executeToolCalls as executeToolCallsRaw } from "./tools/execute.js";
import { initObs, wrapStreamChat, wrapRunTurn, wrapToolExec } from "./obs/index.js";
```

- [ ] **Step 3: 在 `main()` 顶部初始化并建包装局部量**

在 `main()`(`src/index.ts:123`)最前面、任何用到这三者之前(第一处是 461),插入:
```ts
  await initObs(rawArgs.includes("--obs"));
  const streamChat = wrapStreamChat(streamChatRaw);
  const runTurn = wrapRunTurn(runTurnRaw);
  const executeToolCalls = wrapToolExec(executeToolCallsRaw);
```
> `rawArgs` 已在 `src/index.ts:131` 定义为 `process.argv.slice(2)`。若 `initObs` 那行位置在 `rawArgs` 定义之前,则把这四行放到 131 之后、461 之前的任意点。三个 `const` 会在 `main()` 作用域内遮蔽原 import 名,`main()` 内所有 `streamChat(...)`/`runTurn(...)`/`executeToolCalls` 引用自动用上包装版(关闭时是引用相等的原函数,零开销)。

- [ ] **Step 4: 把 `--obs` 加进 flags 集合**

`src/index.ts:202` 的 flags Set 里加 `"--obs"`,避免它被当 prompt 拼接:
```ts
  const flags = new Set(["--yolo", "--continue", "-c", "--goal", "--task", "--coordinator", "--verbose", "--debug", "--api-key", "--provider", "--obs"]);
```

- [ ] **Step 5: 校验无模块作用域漏网引用**

Run:
```bash
grep -n "streamChatRaw\|runTurnRaw\|executeToolCallsRaw\|\bstreamChat\b\|\brunTurn\b\|\bexecuteToolCalls\b" src/index.ts | head -40
```
Expected:除新增的 import(`*Raw`)与 `main()` 顶部三个 `const` 外,其余 `streamChat`/`runTurn`/`executeToolCalls` 引用都应落在 `main()` 内(行号 > 123)。若发现 `main()` 之外(模块作用域)仍引用裸名 → 那几处改用 `*Raw`(它们拿不到 `main()` 局部包装,用原函数即可)。

- [ ] **Step 6: typecheck + 全量测试**

Run:
```bash
npm run typecheck && npx vitest run
```
Expected:typecheck 通过;既有测试全绿 + 新增 obs 测试全绿。

- [ ] **Step 7: 提交**

```bash
git add src/index.ts package.json package-lock.json
git commit -m "feat(obs): 接线 --obs flag + 组合根包装 streamChat/runTurn/toolExec"
```

- [ ] **Step 8: 真实 docker 联通(手动验收)**

```bash
# 起后端
git clone https://github.com/lmnr-ai/lmnr /tmp/lmnr && cd /tmp/lmnr && docker compose up -d
# 浏览器开 http://localhost:5667 注册、建 project、复制 API key
export LMNR_PROJECT_API_KEY=<key>
cd /Users/huaruoxu/ClaudeProject/dao-code
npm run dev -- --obs "读一下 package.json 并总结"
```
Expected:`http://localhost:5667` 的 Traces 里出现一条 trace,含 `turn` → `llm.call`(有 model/token/cache tag)→ `tool.read_file`。
若 `turn`/`llm.call`/`tool.*` 呈平级而非嵌套 → 按 Task 4 的「实现说明」把 `withActive` 落成 `Laminar.withSpan(rawSpan, fn)` 后重验。

---

### Task 6(Spike,可选,不阻塞主线): bun `--compile` 能否带观测

**Files:** 无代码产出;结论回填 `docs/superpowers/specs/2026-07-02-laminar-observability-design.md` 的「未决/后续」。

- [ ] **Step 1: 编译带 lmnr 的二进制**

```bash
npm run bundle
```
Expected 观察:能否成功编译(`@lmnr-ai/lmnr` 的 OTel Node 依赖可能报错)。

- [ ] **Step 2: 二进制跑观测**

```bash
export LMNR_PROJECT_API_KEY=<key>
./dao --obs "读一下 package.json"
```
分三种结论回填文档:
1. 编译成功且 UI 见 trace → 二进制支持观测,更新 spec。
2. 编译成功但运行时观测报错(降级 warn、主功能正常)→ 记录「二进制下观测降级,走 node/tsx」。
3. 编译失败 → 确认 `--obs` 默认关闭时二进制仍能正常 `npm run bundle` 出(即未开观测不触发 lmnr import);记录「二进制不带观测,观测仅 dev/node 路径」。

- [ ] **Step 3: 回填文档并提交**

```bash
git add docs/superpowers/specs/2026-07-02-laminar-observability-design.md
git commit -m "docs(obs): 回填 bun --compile 观测 spike 结论"
```

---

## Self-Review

**1. Spec coverage:**
- 全链路 trace(turn→llm→tool→subagent→memory)→ Task 3 三包装器 + Task 5 接线;memory 因走同一 `streamChat` 包装自动覆盖 ✓
- 自托管 Docker → Task 5 Step 8 ✓
- 方案 A 组合根包装、核心文件不动 → Task 5 用 import 重命名 + `main()` 内 shadow,未碰 client/loop/execute ✓
- optionalDependency + 动态 import → Task 4 initObs + Task 5 Step 1 ✓
- `--obs` 开关默认关 → Task 5 Step 3/4;关闭态透传 → Task 3 引用相等测试 ✓
- streamChat 是 generator 的手动 span → Task 3 wrapStreamChat + 异常收尾测试 ✓
- 退出 flush → Task 2 registerExitFlush + Task 4 注册 ✓
- 错误降级不影响主链路 → Task 4 catch 降级;Task 2 flush 2s 超时 ✓
- span 属性(model/token/cache)→ Task 1 attrs + Task 3 写入测试 ✓
- Bun compile 风险 spike → Task 6 ✓

**2. Placeholder scan:** 无 TBD/TODO;每个代码步骤含完整代码。Task 4 的 `withActive` 简化 + 嵌套定稿点是**显式记录的已知取舍**并给了落地方式,非占位。✓

**3. Type consistency:** `ObsBackend`/`ObsSpan`(Task 2)在 Task 3/4 用法一致(`startSpan({name,spanType,input,sessionId,metadata})`、`setAttributes`、`end`、`withActive`、`flush`);`llmAttributes`/`cacheTag`(Task 1)签名与 Task 3 调用一致;`initObs(on: boolean)`(Task 4)与 Task 5 调用一致;属性键字符串常量在 attrs.ts 与 wrap.ts 一致。✓
