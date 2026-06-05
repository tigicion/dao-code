# codeds M2 — Tool Loop 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 M1 的单轮骨架升级成**多轮 agent turn loop + 工具调用**:模型可以在一轮里请求若干工具(并行),codeds 批量并发执行、把结果回灌,继续下一轮,直到模型不再要工具。落地两个只读工具 `read_file` / `list_dir`,并**实测 DeepSeek 的 `parallel_tool_calls`**(§13 唯一未决项)。

**Architecture:** 在 M1 的依赖注入骨架上扩展。client 从「只 yield 文本 delta」升级为「yield delta 用于渲染 + 把整条 assistant 消息(含拼装好的 tool_calls)作为 generator 返回值」。新增 `tools/` 模块:工具用 zod 定义(单一 schema 既校验运行时参数、又生成发给 API 的 JSON schema),注册表保持插入顺序(前缀 cache 友好),并发执行器把 N 个 tool_call 并发跑、各自产出 `role:"tool"` 结果消息。`agent/loop.ts` 驱动多轮循环并渲染。所有外部 IO(fetch / stdout / fs 通过 ctx 的 workspaceRoot)仍可注入或隔离,单测不触网。

**Tech Stack:** 沿用 M1(Node20+/TS-ESM/vitest/tsx/原生 fetch)。**新增运行时依赖:`zod`(参数校验)+ `zod-to-json-schema`(zod→JSON schema)**。

参考:设计文档 `docs/2026-06-04-deepseek-coding-agent-design.md`(§4 工具集、§5 审批框架、§10 cache、§11 架构、§12 工具执行时序、§13 已验证 API 事实)。M1 计划 `docs/superpowers/plans/2026-06-05-codeds-m1-walking-skeleton.md`。

**承接 M1 carry-over(本计划处理)**:① SSE 加 `\r\n` 容错(Task 2);② client 流末 buffer flush(Task 5)。M1 的 `runner.ts` 单轮被本里程碑的 agent loop 取代,Task 10 删除它;故「runner system-message 分支测试」这条 carry-over 随之作废(system prompt 的真正接入在 M5)。

**范围边界(M2 不做,留给后续里程碑)**:审批门 / PathEscape(M3)——故 M2 工具 `approval` 字段已声明但**不强制**,`read_file`/`list_dir` 路径仅按 workspaceRoot 解析、暂不阻止越界;写/执行类工具(M3);其余工具(M4);系统 prompt 组装与模式(M5)。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `package.json` | 加 `zod` / `zod-to-json-schema` 依赖 | 改 |
| `src/client/sse.ts` | `parseSSEChunk` 增加 `\r\n` 容错 | 改 |
| `src/client/types.ts` | ChatMessage 升级为联合(system/user/assistant/tool)+ `ToolCall`/`AssistantMessage`/`ApiTool`;`StreamDelta` 加 tool_call 变体;`StreamChatOptions` 加 `tools`/`parallelToolCalls` | 改 |
| `src/client/client.ts` | 流式拼装 tool_calls + content,返回 `AssistantMessage`;body 带 tools/parallel_tool_calls;流末 flush | 改 |
| `src/tools/types.ts` | `Tool`/`ToolContext`/`Capability`/`Approval`/`defineTool`/`ToolDispatcher` | 新建 |
| `src/tools/schema.ts` | `toJsonSchema(zodSchema)`:zod→干净 JSON schema | 新建 |
| `src/tools/registry.ts` | `ToolRegistry`:register/get/toApiTools/dispatch(校验+派发) | 新建 |
| `src/tools/read_file.ts` | `read_file` 工具(带行号、offset/limit) | 新建 |
| `src/tools/list_dir.ts` | `list_dir` 工具(目录以 / 结尾) | 新建 |
| `src/tools/execute.ts` | `executeToolCalls`:并发执行 + 错误隔离 → `ToolMessage[]` | 新建 |
| `src/agent/loop.ts` | `runAgent`:多轮 loop + 渲染 + loop guard | 新建 |
| `src/index.ts` | 装配 registry + 调 `runAgent`(替代 runOnce) | 改 |
| `src/runner.ts` / `src/runner.test.ts` | 被 agent loop 取代 | 删 |

---

## Task 1: 新增依赖 zod / zod-to-json-schema

**Files:** Modify `package.json`

- [ ] **Step 1:** 在 `package.json` 增加运行时依赖块(放在 `devDependencies` 之前)。最终 `package.json` 应含:
```json
  "dependencies": {
    "zod": "^3.23.0",
    "zod-to-json-schema": "^3.23.0"
  },
```
(保留已有 `scripts`/`devDependencies` 不变。)

- [ ] **Step 2:** 安装:`cd /Users/huaruoxu/ClaudeProject/career_plan/code/codeds && npm install`
Expected: 新增 zod / zod-to-json-schema,`package-lock.json` 更新。

- [ ] **Step 3:** 确认现有测试仍绿:`npx vitest run`
Expected: 13 passed(M1 全量未受影响)。

- [ ] **Step 4:** 提交
```bash
git add package.json package-lock.json
git commit -m "chore(deps): add zod and zod-to-json-schema for tool schemas"
```

---

## Task 2: SSE `\r\n` 容错(M1 carry-over)

**Files:** Modify `src/client/sse.ts` and `src/client/sse.test.ts`

**契约不变**,只是 `parseSSEChunk` 在按 `\n\n` 切分前,先把 `\r\n` 归一化成 `\n`,使 CRLF 行尾也能正确分事件、且 payload 不带尾随 `\r`。

- [ ] **Step 1: 追加失败测试**(加到 `src/client/sse.test.ts` 的 describe 内)
```ts
  it("normalizes CRLF line endings", () => {
    const r = parseSSEChunk('data: {"a":1}\r\n\r\ndata: [DONE]\r\n\r\n');
    expect(r.payloads).toEqual(['{"a":1}', "[DONE]"]);
    expect(r.rest).toBe("");
  });
```

- [ ] **Step 2:** 运行 `npx vitest run src/client/sse.test.ts` — 新用例 FAIL(现有按 `\n\n` 切,CRLF 不匹配)。

- [ ] **Step 3: 改实现**——把 `src/client/sse.ts` 的 `parseSSEChunk` 第一行 split 前归一化:
```ts
export function parseSSEChunk(buffer: string): SSEParseResult {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? ""; // 最后一段可能不完整
  const payloads: string[] = [];
  for (const event of parts) {
    for (const line of event.split("\n")) {
      if (line.startsWith("data:")) {
        payloads.push(line.slice("data:".length).trim());
      }
    }
  }
  return { payloads, rest };
}
```
> 注意:`rest` 现在是归一化后的残留(`\r\n`→`\n`)。这无副作用,因为调用方只把 `rest` 再喂回 `parseSSEChunk`,会再次归一化;不会丢字节。

- [ ] **Step 4:** `npx vitest run src/client/sse.test.ts` — 6 用例全 PASS。

- [ ] **Step 5:** `npx tsc --noEmit` — clean。

- [ ] **Step 6:** 提交
```bash
git add src/client/sse.ts src/client/sse.test.ts
git commit -m "fix(client): tolerate CRLF line endings in SSE parsing"
```

---

## Task 3: 扩展 client 类型(消息联合 + 工具 + StreamDelta)

**Files:** Rewrite `src/client/types.ts`(无独立测试,被 Task 5 client 测试覆盖)

- [ ] **Step 1: 整体重写 `src/client/types.ts`(EXACT)**
```ts
// ---- 对话消息 ----
export interface SystemMessage {
  role: "system";
  content: string;
}
export interface UserMessage {
  role: "user";
  content: string;
}
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}
export interface ToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}
export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

// ---- 流式增量(用于渲染)----
export type StreamDelta =
  | { kind: "reasoning"; text: string }
  | { kind: "content"; text: string }
  | { kind: "tool_call"; index: number; name: string };

// ---- 发给 API 的工具声明 ----
export interface ApiTool {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export interface StreamChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  // 工具声明(JSON schema);省略则不带 tools 字段。
  tools?: ApiTool[];
  // 是否允许并行工具调用;省略则不带该字段(交给 API 默认)。
  parallelToolCalls?: boolean;
  // 注入 fetch,便于测试;默认用全局 fetch。
  fetchImpl?: typeof fetch;
  // 透传给 API 的额外字段(如 thinking、reasoning_effort)。
  extra?: Record<string, unknown>;
}
```

- [ ] **Step 2:** `npx tsc --noEmit`。
Expected: 会报错——`src/client/client.ts`(M1 版)和 `src/runner.ts` 仍按旧 `ChatMessage`(只有 `{role,content}`)使用,联合类型收紧后旧代码可能不兼容。**这是预期的**:Task 5 重写 client、Task 10 删 runner 后即恢复。本步只确认错误集中在 client.ts / runner.ts,不在 types.ts 自身。

- [ ] **Step 3:** 提交(允许此刻 tsc 未全绿,因为是分步重构的中间态)
```bash
git add src/client/types.ts
git commit -m "feat(client): message union, tool call types, tool-aware stream options"
```

---

## Task 4: 工具基础设施(types + schema 助手)

**Files:** Create `src/tools/types.ts`, `src/tools/schema.ts`, Test `src/tools/schema.test.ts`

- [ ] **Step 1: 写 `src/tools/types.ts`(EXACT)**
```ts
import type { ZodTypeAny, z } from "zod";

export type Capability = "read" | "write" | "exec" | "network" | "plan";
export type Approval = "auto" | "suggest" | "required";

export interface ToolContext {
  // 工具的文件根目录;路径相对它解析。
  workspaceRoot: string;
}

// 注册表内统一存储的工具(handler 参数在派发时由 schema 校验后传入)。
export interface Tool {
  name: string;
  description: string;
  schema: ZodTypeAny;
  capability: Capability;
  approval: Approval;
  handler: (args: any, ctx: ToolContext) => Promise<string>;
}

// 定义单个工具时用,保留 handler 参数的精确类型(z.infer<S>)。
export interface ToolDefinition<S extends ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  capability: Capability;
  approval: Approval;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<string>;
}

export function defineTool<S extends ZodTypeAny>(def: ToolDefinition<S>): Tool {
  // handler 的精确参数类型擦除为 any;运行时由 registry 先 schema.parse 再调用,保证安全。
  return def as unknown as Tool;
}

// 执行器只依赖「能按名字派发」这一能力,便于测试时注入桩。
export interface ToolDispatcher {
  dispatch(name: string, rawArgs: string, ctx: ToolContext): Promise<string>;
}
```

- [ ] **Step 2: 写失败测试 `src/tools/schema.test.ts`**
```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { toJsonSchema } from "./schema.js";

describe("toJsonSchema", () => {
  it("converts a zod object to a clean JSON schema without $schema", () => {
    const schema = z.object({
      path: z.string(),
      limit: z.number().int().optional(),
    });
    const json = toJsonSchema(schema) as any;
    expect(json.$schema).toBeUndefined();
    expect(json.type).toBe("object");
    expect(json.properties.path.type).toBe("string");
    expect(json.required).toContain("path");
    expect(json.required).not.toContain("limit");
  });
});
```

- [ ] **Step 3:** `npx vitest run src/tools/schema.test.ts` — FAIL(模块不存在)。

- [ ] **Step 4: 写 `src/tools/schema.ts`(EXACT)**
```ts
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";

// 把 zod schema 转成发给 DeepSeek function calling 的 parameters JSON schema。
// 去掉 $schema 顶层键(API 不需要,且影响前缀字节稳定性)。
export function toJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}
```

- [ ] **Step 5:** `npx vitest run src/tools/schema.test.ts` — PASS。

- [ ] **Step 6:** 提交
```bash
git add src/tools/types.ts src/tools/schema.ts src/tools/schema.test.ts
git commit -m "feat(tools): tool definition types and zod-to-JSON-schema helper"
```

---

## Task 5: 重写 client —— 流式拼装 tool_calls,返回 AssistantMessage

**Files:** Rewrite `src/client/client.ts`, Rewrite `src/client/client.test.ts`

**契约:** `streamChat(opts): AsyncGenerator<StreamDelta, AssistantMessage>`。流式期间 yield delta 供渲染;**返回值是整条拼好的 assistant 消息**(content + 按 index 拼装的 tool_calls)。body 在有 `tools` 时带 `tools`、有 `parallelToolCalls` 时带 `parallel_tool_calls`。读流结束后做一次 flush。

- [ ] **Step 1: 整体重写测试 `src/client/client.test.ts`(EXACT)**
```ts
import { describe, it, expect } from "vitest";
import { streamChat } from "./client.js";
import type { StreamDelta, AssistantMessage } from "./types.js";

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]!));
      else controller.close();
    },
  });
}

function fakeFetch(chunks: string[], status = 200): typeof fetch {
  return (async () =>
    new Response(status === 200 ? sseStream(chunks) : "boom", { status })) as unknown as typeof fetch;
}

// 手动驱动 generator:收集 deltas,并拿到 return 值(assistant 消息)。
async function run(
  gen: AsyncGenerator<StreamDelta, AssistantMessage>,
): Promise<{ deltas: StreamDelta[]; message: AssistantMessage }> {
  const deltas: StreamDelta[] = [];
  let r = await gen.next();
  while (!r.done) {
    deltas.push(r.value);
    r = await gen.next();
  }
  return { deltas, message: r.value };
}

const base = { baseUrl: "https://x", apiKey: "sk", model: "deepseek-v4-pro" };

describe("streamChat", () => {
  it("yields reasoning+content and returns an assistant message with content", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const { deltas, message } = await run(
      streamChat({ ...base, messages: [{ role: "user", content: "hi" }], fetchImpl: fakeFetch(chunks) }),
    );
    expect(deltas).toEqual([
      { kind: "reasoning", text: "think" },
      { kind: "content", text: "hello" },
    ]);
    expect(message).toEqual({ role: "assistant", content: "hello" });
  });

  it("assembles a single tool_call from streamed fragments", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const { deltas, message } = await run(
      streamChat({ ...base, messages: [{ role: "user", content: "hi" }], fetchImpl: fakeFetch(chunks) }),
    );
    expect(deltas).toContainEqual({ kind: "tool_call", index: 0, name: "read_file" });
    expect(message.content).toBeNull();
    expect(message.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
    ]);
  });

  it("assembles two parallel tool_calls by index", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","type":"function","function":{"name":"read_file","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c1","type":"function","function":{"name":"list_dir","arguments":"{}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const { message } = await run(
      streamChat({ ...base, messages: [{ role: "user", content: "hi" }], fetchImpl: fakeFetch(chunks) }),
    );
    expect(message.tool_calls?.map((t) => t.function.name)).toEqual(["read_file", "list_dir"]);
    expect(message.tool_calls?.map((t) => t.id)).toEqual(["c0", "c1"]);
  });

  it("includes tools and parallel_tool_calls in the request body", async () => {
    let sentBody: any;
    const capturingFetch = (async (_url: string, init: any) => {
      sentBody = JSON.parse(init.body);
      return new Response(sseStream(["data: [DONE]\n\n"]), { status: 200 });
    }) as unknown as typeof fetch;
    await run(
      streamChat({
        ...base,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "read_file", description: "d", parameters: {} } }],
        parallelToolCalls: true,
        fetchImpl: capturingFetch,
      }),
    );
    expect(sentBody.tools).toHaveLength(1);
    expect(sentBody.parallel_tool_calls).toBe(true);
    expect(sentBody.stream).toBe(true);
  });

  it("throws on non-2xx responses", async () => {
    await expect(
      run(streamChat({ ...base, messages: [{ role: "user", content: "hi" }], fetchImpl: fakeFetch([], 401) })),
    ).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2:** `npx vitest run src/client/client.test.ts` — FAIL(旧 client 不返回 message、不拼 tool_calls)。

- [ ] **Step 3: 整体重写 `src/client/client.ts`(EXACT)**
```ts
import { parseSSEChunk } from "./sse.js";
import type {
  AssistantMessage,
  StreamChatOptions,
  StreamDelta,
  ToolCall,
} from "./types.js";

export async function* streamChat(
  opts: StreamChatOptions,
): AsyncGenerator<StreamDelta, AssistantMessage> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.parallelToolCalls !== undefined
      ? { parallel_tool_calls: opts.parallelToolCalls }
      : {}),
    ...opts.extra,
  };

  const res = await fetchImpl(`${opts.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DeepSeek API error ${res.status}: ${text}`);
  }
  if (!res.body) {
    throw new Error("DeepSeek API returned an empty body");
  }

  // 累积状态
  let content = "";
  const toolAcc: { id: string; name: string; args: string }[] = [];
  const announced = new Set<number>();

  // 处理单个 SSE payload,产出渲染 delta(并更新累积状态)。
  function processPayload(payload: string): StreamDelta[] {
    if (payload === "[DONE]" || payload === "") return [];
    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return []; // 半个 JSON 不该出现(已按 \n\n 切),保险跳过
    }
    const delta = parsed?.choices?.[0]?.delta;
    if (!delta) return [];
    const out: StreamDelta[] = [];
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      out.push({ kind: "reasoning", text: delta.reasoning_content });
    }
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      out.push({ kind: "content", text: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const frag of delta.tool_calls) {
        const idx: number = typeof frag.index === "number" ? frag.index : 0;
        let acc = toolAcc[idx];
        if (!acc) {
          acc = { id: "", name: "", args: "" };
          toolAcc[idx] = acc;
        }
        if (typeof frag.id === "string") acc.id = frag.id;
        if (frag.function) {
          if (typeof frag.function.name === "string") acc.name += frag.function.name;
          if (typeof frag.function.arguments === "string") acc.args += frag.function.arguments;
        }
        if (acc.name && !announced.has(idx)) {
          announced.add(idx);
          out.push({ kind: "tool_call", index: idx, name: acc.name });
        }
      }
    }
    return out;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { payloads, rest } = parseSSEChunk(buffer);
    buffer = rest;
    for (const payload of payloads) {
      for (const d of processPayload(payload)) yield d;
    }
  }

  // 流末 flush:处理可能残留的、未以 \n\n 收尾的最后一个事件。
  buffer += decoder.decode();
  if (buffer.trim()) {
    const { payloads } = parseSSEChunk(buffer.endsWith("\n\n") ? buffer : buffer + "\n\n");
    for (const payload of payloads) {
      for (const d of processPayload(payload)) yield d;
    }
  }

  const tool_calls: ToolCall[] = toolAcc
    .filter((a) => a && a.name)
    .map((a) => ({
      id: a.id,
      type: "function" as const,
      function: { name: a.name, arguments: a.args },
    }));

  const message: AssistantMessage = {
    role: "assistant",
    content: content || null,
    ...(tool_calls.length ? { tool_calls } : {}),
  };
  return message;
}
```

- [ ] **Step 4:** `npx vitest run src/client/client.test.ts` — 5 用例 PASS。

- [ ] **Step 5:** `npx tsc --noEmit`。
Expected: client.ts 自身已绿;若仍报错,应只剩 `src/runner.ts`/`src/index.ts` 引用旧形状——这些在 Task 10 处理。确认错误不在 client.ts。

- [ ] **Step 6:** 提交
```bash
git add src/client/client.ts src/client/client.test.ts
git commit -m "feat(client): assemble streamed tool_calls and return assistant message"
```

---

## Task 6: 工具注册表

**Files:** Create `src/tools/registry.ts`, Test `src/tools/registry.test.ts`

**契约:** `ToolRegistry`:`register(tool)`、`get(name)`、`toApiTools(): ApiTool[]`(按注册顺序,前缀稳定)、`dispatch(name, rawArgs, ctx)`——查工具(找不到抛 `unknown tool: <name>`)、`JSON.parse` 参数(失败抛 `invalid JSON arguments for <name>`)、`schema.parse` 校验(非法抛 ZodError)、调 handler 返回字符串。实现 `ToolDispatcher`。

- [ ] **Step 1: 写失败测试 `src/tools/registry.test.ts`(EXACT)**
```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "./registry.js";
import { defineTool } from "./types.js";

function makeEcho() {
  return defineTool({
    name: "echo",
    description: "echoes the text",
    capability: "read",
    approval: "auto",
    schema: z.object({ text: z.string() }),
    handler: async (args) => `echo:${args.text}`,
  });
}

describe("ToolRegistry", () => {
  it("registers and dispatches a tool with validated args", async () => {
    const reg = new ToolRegistry();
    reg.register(makeEcho());
    const out = await reg.dispatch("echo", '{"text":"hi"}', { workspaceRoot: "/tmp" });
    expect(out).toBe("echo:hi");
  });

  it("exposes API tools in registration order with name/description/parameters", () => {
    const reg = new ToolRegistry();
    reg.register(makeEcho());
    const api = reg.toApiTools();
    expect(api).toHaveLength(1);
    expect(api[0]!.type).toBe("function");
    expect(api[0]!.function.name).toBe("echo");
    expect(api[0]!.function.description).toBe("echoes the text");
    expect((api[0]!.function.parameters as any).type).toBe("object");
  });

  it("throws on unknown tool", async () => {
    const reg = new ToolRegistry();
    await expect(reg.dispatch("nope", "{}", { workspaceRoot: "/tmp" })).rejects.toThrow(/unknown tool: nope/);
  });

  it("throws on invalid JSON arguments", async () => {
    const reg = new ToolRegistry();
    reg.register(makeEcho());
    await expect(reg.dispatch("echo", "{not json", { workspaceRoot: "/tmp" })).rejects.toThrow(
      /invalid JSON arguments for echo/,
    );
  });

  it("throws when args fail schema validation", async () => {
    const reg = new ToolRegistry();
    reg.register(makeEcho());
    await expect(reg.dispatch("echo", '{"text":123}', { workspaceRoot: "/tmp" })).rejects.toThrow();
  });
});
```

- [ ] **Step 2:** `npx vitest run src/tools/registry.test.ts` — FAIL(模块不存在)。

- [ ] **Step 3: 写 `src/tools/registry.ts`(EXACT)**
```ts
import type { ApiTool } from "../client/types.js";
import { toJsonSchema } from "./schema.js";
import type { Tool, ToolContext, ToolDispatcher } from "./types.js";

export class ToolRegistry implements ToolDispatcher {
  // Map 保留插入顺序 → toApiTools 输出稳定,利于前缀 cache。
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  toApiTools(): ApiTool[] {
    return [...this.tools.values()].map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: toJsonSchema(t.schema),
      },
    }));
  }

  async dispatch(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);

    let json: unknown;
    try {
      json = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch {
      throw new Error(`invalid JSON arguments for ${name}`);
    }

    const args = tool.schema.parse(json); // 非法参数抛 ZodError
    return tool.handler(args, ctx);
  }
}
```

- [ ] **Step 4:** `npx vitest run src/tools/registry.test.ts` — 5 用例 PASS。

- [ ] **Step 5:** `npx tsc --noEmit`(确认 registry/tools 部分无错)。

- [ ] **Step 6:** 提交
```bash
git add src/tools/registry.ts src/tools/registry.test.ts
git commit -m "feat(tools): registry with ordered API tools and validating dispatch"
```

---

## Task 7: read_file 工具

**Files:** Create `src/tools/read_file.ts`, Test `src/tools/read_file.test.ts`

**契约:** `read_file`,参数 `{ path: string; offset?: number(>=1); limit?: number(>=1) }`。读 `path.resolve(workspaceRoot, path)`,UTF-8,按行返回 `${行号}\t${行}`(行号 1-based);`offset` 指起始行、`limit` 指行数;文件不存在时 handler 抛错(由上层执行器转成错误结果)。

- [ ] **Step 1: 写失败测试 `src/tools/read_file.test.ts`(EXACT)**
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileTool } from "./read_file.js";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codeds-readfile-"));
  await fs.writeFile(path.join(root, "a.txt"), "line1\nline2\nline3\n", "utf8");
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("read_file tool", () => {
  it("returns file content with 1-based line numbers", async () => {
    const out = await readFileTool.handler({ path: "a.txt" }, { workspaceRoot: root });
    expect(out).toContain("1\tline1");
    expect(out).toContain("2\tline2");
    expect(out).toContain("3\tline3");
  });

  it("honors offset and limit", async () => {
    const out = await readFileTool.handler({ path: "a.txt", offset: 2, limit: 1 }, { workspaceRoot: root });
    expect(out).toBe("2\tline2");
  });

  it("throws when the file is missing", async () => {
    await expect(
      readFileTool.handler({ path: "nope.txt" }, { workspaceRoot: root }),
    ).rejects.toThrow();
  });

  it("declares read capability and auto approval", () => {
    expect(readFileTool.capability).toBe("read");
    expect(readFileTool.approval).toBe("auto");
    expect(readFileTool.name).toBe("read_file");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/tools/read_file.test.ts` — FAIL(模块不存在)。

- [ ] **Step 3: 写 `src/tools/read_file.ts`(EXACT)**
```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "./types.js";

export const readFileTool = defineTool({
  name: "read_file",
  description:
    "读取工作区内的文本文件,返回带行号(1-based)的内容。可用 offset 指定起始行、limit 指定读取行数。",
  capability: "read",
  approval: "auto",
  schema: z.object({
    path: z.string().describe("相对工作区根目录的文件路径"),
    offset: z.number().int().min(1).optional().describe("起始行号(1-based,含)"),
    limit: z.number().int().min(1).optional().describe("最多读取的行数"),
  }),
  handler: async (args, ctx) => {
    const abs = path.resolve(ctx.workspaceRoot, args.path);
    const raw = await fs.readFile(abs, "utf8");
    const lines = raw.split("\n");
    const start = args.offset ? args.offset - 1 : 0;
    const end = args.limit !== undefined ? start + args.limit : lines.length;
    return lines
      .slice(start, end)
      .map((line, i) => `${start + i + 1}\t${line}`)
      .join("\n");
  },
});
```

- [ ] **Step 4:** `npx vitest run src/tools/read_file.test.ts` — 4 用例 PASS。

- [ ] **Step 5:** `npx tsc --noEmit`。

- [ ] **Step 6:** 提交
```bash
git add src/tools/read_file.ts src/tools/read_file.test.ts
git commit -m "feat(tools): read_file with line numbers and offset/limit"
```

---

## Task 8: list_dir 工具

**Files:** Create `src/tools/list_dir.ts`, Test `src/tools/list_dir.test.ts`

**契约:** `list_dir`,参数 `{ path?: string }`(默认 `.`)。读 `path.resolve(workspaceRoot, path ?? ".")`,返回条目名按字典序排列,目录加尾随 `/`;空目录返回 `(空目录)`;目录不存在时抛错。

- [ ] **Step 1: 写失败测试 `src/tools/list_dir.test.ts`(EXACT)**
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listDirTool } from "./list_dir.js";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codeds-listdir-"));
  await fs.writeFile(path.join(root, "file.txt"), "x", "utf8");
  await fs.mkdir(path.join(root, "sub"));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("list_dir tool", () => {
  it("lists entries with a trailing slash on directories, sorted", async () => {
    const out = await listDirTool.handler({}, { workspaceRoot: root });
    expect(out).toBe("file.txt\nsub/");
  });

  it("lists a subdirectory by relative path", async () => {
    const out = await listDirTool.handler({ path: "sub" }, { workspaceRoot: root });
    expect(out).toBe("(空目录)");
  });

  it("throws when the directory is missing", async () => {
    await expect(listDirTool.handler({ path: "nope" }, { workspaceRoot: root })).rejects.toThrow();
  });

  it("declares read capability and auto approval", () => {
    expect(listDirTool.capability).toBe("read");
    expect(listDirTool.approval).toBe("auto");
    expect(listDirTool.name).toBe("list_dir");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/tools/list_dir.test.ts` — FAIL(模块不存在)。

- [ ] **Step 3: 写 `src/tools/list_dir.ts`(EXACT)**
```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "./types.js";

export const listDirTool = defineTool({
  name: "list_dir",
  description: "列出工作区内某个目录的条目,目录名以 / 结尾,按字典序排列。",
  capability: "read",
  approval: "auto",
  schema: z.object({
    path: z.string().optional().describe("相对工作区根目录的目录路径,默认根目录"),
  }),
  handler: async (args, ctx) => {
    const abs = path.resolve(ctx.workspaceRoot, args.path ?? ".");
    const entries = await fs.readdir(abs, { withFileTypes: true });
    if (entries.length === 0) return "(空目录)";
    return entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join("\n");
  },
});
```

- [ ] **Step 4:** `npx vitest run src/tools/list_dir.test.ts` — 4 用例 PASS。

- [ ] **Step 5:** `npx tsc --noEmit`。

- [ ] **Step 6:** 提交
```bash
git add src/tools/list_dir.ts src/tools/list_dir.test.ts
git commit -m "feat(tools): list_dir with trailing-slash directories"
```

---

## Task 9: 并发工具执行器

**Files:** Create `src/tools/execute.ts`, Test `src/tools/execute.test.ts`

**契约:** `executeToolCalls(toolCalls: ToolCall[], dispatcher: ToolDispatcher, ctx: ToolContext): Promise<ToolMessage[]>`。把每个 tool_call **并发**派发(`Promise.all`),结果映射成 `{ role:"tool", tool_call_id, content }`;某个工具抛错时,该条结果 content 为 `Error: <message>`(不让整批 reject)。

- [ ] **Step 1: 写失败测试 `src/tools/execute.test.ts`(EXACT)**
```ts
import { describe, it, expect } from "vitest";
import { executeToolCalls } from "./execute.js";
import type { ToolCall } from "../client/types.js";
import type { ToolContext, ToolDispatcher } from "./types.js";

const ctx: ToolContext = { workspaceRoot: "/tmp" };

function call(id: string, name: string, args = "{}"): ToolCall {
  return { id, type: "function", function: { name, arguments: args } };
}

describe("executeToolCalls", () => {
  it("maps each tool call to a tool message keyed by tool_call_id", async () => {
    const dispatcher: ToolDispatcher = {
      dispatch: async (name) => `result:${name}`,
    };
    const out = await executeToolCalls([call("a", "read_file"), call("b", "list_dir")], dispatcher, ctx);
    expect(out).toEqual([
      { role: "tool", tool_call_id: "a", content: "result:read_file" },
      { role: "tool", tool_call_id: "b", content: "result:list_dir" },
    ]);
  });

  it("isolates a failing tool as an error message without rejecting the batch", async () => {
    const dispatcher: ToolDispatcher = {
      dispatch: async (name) => {
        if (name === "bad") throw new Error("boom");
        return "ok";
      },
    };
    const out = await executeToolCalls([call("a", "bad"), call("b", "good")], dispatcher, ctx);
    expect(out[0]).toEqual({ role: "tool", tool_call_id: "a", content: "Error: boom" });
    expect(out[1]).toEqual({ role: "tool", tool_call_id: "b", content: "ok" });
  });

  it("runs the tool calls concurrently (overlapping execution)", async () => {
    const order: string[] = [];
    const dispatcher: ToolDispatcher = {
      dispatch: async (name) => {
        order.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, 15));
        order.push(`end:${name}`);
        return name;
      },
    };
    await executeToolCalls([call("a", "A"), call("b", "B")], dispatcher, ctx);
    // 并发:B 在 A 结束前就已开始
    expect(order.indexOf("start:B")).toBeLessThan(order.indexOf("end:A"));
  });
});
```

- [ ] **Step 2:** `npx vitest run src/tools/execute.test.ts` — FAIL(模块不存在)。

- [ ] **Step 3: 写 `src/tools/execute.ts`(EXACT)**
```ts
import type { ToolCall, ToolMessage } from "../client/types.js";
import type { ToolContext, ToolDispatcher } from "./types.js";

// 并发执行一批 tool_call;单个失败被隔离成错误结果,不影响其他与整批。
export async function executeToolCalls(
  toolCalls: ToolCall[],
  dispatcher: ToolDispatcher,
  ctx: ToolContext,
): Promise<ToolMessage[]> {
  return Promise.all(
    toolCalls.map(async (tc): Promise<ToolMessage> => {
      try {
        const content = await dispatcher.dispatch(tc.function.name, tc.function.arguments, ctx);
        return { role: "tool", tool_call_id: tc.id, content };
      } catch (err) {
        return { role: "tool", tool_call_id: tc.id, content: `Error: ${(err as Error).message}` };
      }
    }),
  );
}
```

- [ ] **Step 4:** `npx vitest run src/tools/execute.test.ts` — 3 用例 PASS。

- [ ] **Step 5:** `npx tsc --noEmit`。

- [ ] **Step 6:** 提交
```bash
git add src/tools/execute.ts src/tools/execute.test.ts
git commit -m "feat(tools): concurrent tool-call executor with per-call error isolation"
```

---

## Task 10: Agent turn loop

**Files:** Create `src/agent/loop.ts`, Test `src/agent/loop.test.ts`

**契约:** `runAgent(deps): Promise<ChatMessage[]>`。组消息(可选 system + user)→ 循环:`streamChat({config, messages, tools, parallelToolCalls:true})` 驱动渲染并取回 assistant 消息 → 追加 → 若无 tool_calls 则结束返回全部消息;否则 `executeToolCalls` 并发执行、追加 tool 结果 → 下一轮。`maxTurns`(默认 25)兜底,达上限写提示并停。渲染:reasoning 灰色、content 原样、tool_call announce(`→ <name>`),均经注入的 `write`。

依赖注入签名:
```ts
export interface AgentDeps {
  prompt: string;
  system?: string;
  config: { baseUrl: string; apiKey: string; model: string };
  registry: ToolRegistry;
  ctx: ToolContext;
  streamChat: (opts: StreamChatOptions) => AsyncGenerator<StreamDelta, AssistantMessage>;
  executeToolCalls: (
    toolCalls: ToolCall[],
    dispatcher: ToolDispatcher,
    ctx: ToolContext,
  ) => Promise<ToolMessage[]>;
  write: (s: string) => void;
  maxTurns?: number;
}
```

- [ ] **Step 1: 写失败测试 `src/agent/loop.test.ts`(EXACT)**
```ts
import { describe, it, expect } from "vitest";
import { runAgent } from "./loop.js";
import { ToolRegistry } from "../tools/registry.js";
import type { AssistantMessage, StreamDelta, ToolMessage } from "../client/types.js";

const config = { baseUrl: "https://x", apiKey: "sk", model: "deepseek-v4-pro" };
const ctx = { workspaceRoot: "/tmp" };

// 构造一个「一轮」的假 streamChat:yield 给定 deltas,return 给定 assistant 消息。
function turn(deltas: StreamDelta[], message: AssistantMessage) {
  return async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
    for (const d of deltas) yield d;
    return message;
  };
}
// 按调用次序逐轮返回。
function scripted(turns: Array<() => AsyncGenerator<StreamDelta, AssistantMessage>>) {
  let i = 0;
  return () => turns[i++]!();
}

describe("runAgent", () => {
  it("returns after one turn when the model requests no tools", async () => {
    const written: string[] = [];
    const messages = await runAgent({
      prompt: "hi",
      config,
      registry: new ToolRegistry(),
      ctx,
      streamChat: scripted([
        turn([{ kind: "content", text: "hello" }], { role: "assistant", content: "hello" }),
      ]),
      executeToolCalls: async () => [],
      write: (s) => written.push(s),
    });
    expect(messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(written.join("")).toContain("hello");
  });

  it("executes tools then loops until the model stops requesting them", async () => {
    const assistantWithTool: AssistantMessage = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c0", type: "function", function: { name: "read_file", arguments: "{}" } }],
    };
    const toolResult: ToolMessage[] = [{ role: "tool", tool_call_id: "c0", content: "FILE BODY" }];
    const messages = await runAgent({
      prompt: "read a",
      config,
      registry: new ToolRegistry(),
      ctx,
      streamChat: scripted([
        turn([{ kind: "tool_call", index: 0, name: "read_file" }], assistantWithTool),
        turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" }),
      ]),
      executeToolCalls: async () => toolResult,
      write: () => {},
    });
    expect(messages).toEqual([
      { role: "user", content: "read a" },
      assistantWithTool,
      { role: "tool", tool_call_id: "c0", content: "FILE BODY" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("prepends a system message when provided", async () => {
    const messages = await runAgent({
      prompt: "hi",
      system: "you are codeds",
      config,
      registry: new ToolRegistry(),
      ctx,
      streamChat: scripted([turn([], { role: "assistant", content: "ok" })]),
      executeToolCalls: async () => [],
      write: () => {},
    });
    expect(messages[0]).toEqual({ role: "system", content: "you are codeds" });
  });

  it("stops at maxTurns when the model keeps requesting tools", async () => {
    const written: string[] = [];
    const looping = () =>
      turn([], {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c", type: "function", function: { name: "read_file", arguments: "{}" } }],
      })();
    const messages = await runAgent({
      prompt: "loop",
      config,
      registry: new ToolRegistry(),
      ctx,
      streamChat: scripted([looping, looping, looping, looping, looping]),
      executeToolCalls: async () => [{ role: "tool", tool_call_id: "c", content: "x" }],
      write: (s) => written.push(s),
      maxTurns: 3,
    });
    // 3 轮:每轮 1 条 assistant + 1 条 tool;加最前面的 user = 1 + 3*2 = 7
    expect(messages).toHaveLength(7);
    expect(written.join("")).toContain("最大轮数");
  });
});
```

- [ ] **Step 2:** `npx vitest run src/agent/loop.test.ts` — FAIL(模块不存在)。

- [ ] **Step 3: 写 `src/agent/loop.ts`(EXACT)**
```ts
import type {
  AssistantMessage,
  ChatMessage,
  StreamChatOptions,
  StreamDelta,
  ToolCall,
  ToolMessage,
} from "../client/types.js";
import type { ToolContext, ToolDispatcher } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface AgentDeps {
  prompt: string;
  system?: string;
  config: { baseUrl: string; apiKey: string; model: string };
  registry: ToolRegistry;
  ctx: ToolContext;
  streamChat: (opts: StreamChatOptions) => AsyncGenerator<StreamDelta, AssistantMessage>;
  executeToolCalls: (
    toolCalls: ToolCall[],
    dispatcher: ToolDispatcher,
    ctx: ToolContext,
  ) => Promise<ToolMessage[]>;
  write: (s: string) => void;
  maxTurns?: number;
}

// 驱动一轮 streamChat:渲染 delta,返回拼好的 assistant 消息。
async function renderTurn(
  gen: AsyncGenerator<StreamDelta, AssistantMessage>,
  write: (s: string) => void,
): Promise<AssistantMessage> {
  let inReasoning = false;
  let r = await gen.next();
  while (!r.done) {
    const d = r.value;
    if (d.kind === "reasoning") {
      if (!inReasoning) {
        write("\x1b[90m");
        inReasoning = true;
      }
      write(d.text);
    } else if (d.kind === "content") {
      if (inReasoning) {
        write("\x1b[0m\n\n");
        inReasoning = false;
      }
      write(d.text);
    } else {
      // tool_call
      if (inReasoning) {
        write("\x1b[0m\n");
        inReasoning = false;
      }
      write(`\n→ ${d.name}\n`);
    }
    r = await gen.next();
  }
  if (inReasoning) write("\x1b[0m");
  write("\n");
  return r.value;
}

export async function runAgent(deps: AgentDeps): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  if (deps.system) messages.push({ role: "system", content: deps.system });
  messages.push({ role: "user", content: deps.prompt });

  const tools = deps.registry.toApiTools();
  const maxTurns = deps.maxTurns ?? 25;

  for (let turn = 0; turn < maxTurns; turn++) {
    const gen = deps.streamChat({
      ...deps.config,
      messages,
      tools,
      parallelToolCalls: true,
    });
    const assistant = await renderTurn(gen, deps.write);
    messages.push(assistant);

    if (!assistant.tool_calls || assistant.tool_calls.length === 0) {
      return messages;
    }

    const toolMessages = await deps.executeToolCalls(assistant.tool_calls, deps.registry, deps.ctx);
    messages.push(...toolMessages);
  }

  deps.write("\n[已达最大轮数,停止]\n");
  return messages;
}
```

- [ ] **Step 4:** `npx vitest run src/agent/loop.test.ts` — 4 用例 PASS。

- [ ] **Step 5:** `npx tsc --noEmit`(loop.ts 应无错;runner/index 旧引用在 Task 11 清理)。

- [ ] **Step 6:** 提交
```bash
git add src/agent/loop.ts src/agent/loop.test.ts
git commit -m "feat(agent): multi-turn tool loop with rendering and turn guard"
```

---

## Task 11: 装配 index,移除 runner,全量验收

**Files:** Rewrite `src/index.ts`; Delete `src/runner.ts`, `src/runner.test.ts`

- [ ] **Step 1: 整体重写 `src/index.ts`(EXACT)**
```ts
import { loadConfig } from "./config/config.js";
import { streamChat } from "./client/client.js";
import { runAgent } from "./agent/loop.js";
import { executeToolCalls } from "./tools/execute.js";
import { ToolRegistry } from "./tools/registry.js";
import { readFileTool } from "./tools/read_file.js";
import { listDirTool } from "./tools/list_dir.js";

async function main() {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    console.error('用法: npm run dev -- "你的问题"');
    process.exit(1);
  }

  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(listDirTool);

  await runAgent({
    prompt,
    config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
    registry,
    ctx: { workspaceRoot: process.cwd() },
    streamChat,
    executeToolCalls,
    write: (s) => process.stdout.write(s),
  });
}

main().catch((err) => {
  console.error("\n" + (err as Error).message);
  process.exit(1);
});
```

- [ ] **Step 2: 删除被取代的 runner**
```bash
cd /Users/huaruoxu/ClaudeProject/career_plan/code/codeds
git rm src/runner.ts src/runner.test.ts
```

- [ ] **Step 3: 全量 typecheck**
Run `npx tsc --noEmit`
Expected: 退出码 0,无错误(此刻所有旧形状引用都已清理)。

- [ ] **Step 4: 全量测试**
Run `npx vitest run`
Expected: 全 PASS。预期文件/用例:config(3)、sse(6)、client(5)、tools/schema(1)、tools/registry(5)、tools/read_file(4)、tools/list_dir(4)、tools/execute(3)、agent/loop(4) = **35 用例**。

- [ ] **Step 5: 无网络冒烟**
Run: `DEEPSEEK_API_KEY= npm run dev -- "hello"`
Expected: 打印含 "Missing DEEPSEEK_API_KEY",退出码 1。
Run: `DEEPSEEK_API_KEY=x npm run dev`(无参数)
Expected: 打印用法行,退出码 1。

- [ ] **Step 6: 提交**
```bash
git add src/index.ts
git commit -m "feat: wire agent tool loop into CLI, remove single-turn runner"
```

---

## Task 12: 真网络验收 —— 实测 `parallel_tool_calls`(关闭 §13 未决项)

> 需有效 key,会触网+计费。key 在用户本机 `.env` 的 `DS_API_KEY`,运行时桥接为 `DEEPSEEK_API_KEY`,**不读取/不回显 key 值**。

- [ ] **Step 1: 触发可能的并行工具调用**
Run(在项目目录,key 桥接):
```bash
set -a && . ./.env && set +a && DEEPSEEK_API_KEY="$DS_API_KEY" npm run dev -- "分别读取 package.json 和 tsconfig.json,各用一句话说它们是干嘛的" 2>&1
```
Expected:终端先(可能)打印灰色 reasoning,然后出现一个或两个 `→ read_file` 行,接着模型基于读到的内容给出回答,退出 0。

- [ ] **Step 2: 判定并记录 parallel_tool_calls 实测结论**
观察并记录:
- API 是否**接受** `parallel_tool_calls: true` 不报错?(若报 400 之类参数错 → 见 Step 3 兜底)
- 模型是否在**同一轮**返回了**两个** `read_file`(出现两行连续 `→ read_file`,且二者在一轮内并发执行)?还是一轮一个、串行两轮?
把结论(接受/拒绝、单轮并行/串行)追加到设计文档 `docs/2026-06-04-deepseek-coding-agent-design.md` 的 §13,替换原 `⚠️ parallel_tool_calls` 那条为「✅ 已实测(2026-06-05):<结论>」。

- [ ] **Step 3: 兜底(仅当 API 拒绝该参数)**
若 Step 1 报参数相关 4xx 且定位到 `parallel_tool_calls`:把 `src/agent/loop.ts` 里 `parallelToolCalls: true` 改为不传(删该行),并在 §13 记录「DeepSeek 当前不支持显式 parallel_tool_calls 参数,已移除」。重跑 Step 1 确认恢复正常,然后:
```bash
git add src/agent/loop.ts docs/2026-06-04-deepseek-coding-agent-design.md
git commit -m "fix(agent): drop unsupported parallel_tool_calls per live API test"
```
若 API 接受(无需改代码),只提交文档:
```bash
git add docs/2026-06-04-deepseek-coding-agent-design.md
git commit -m "docs: record live parallel_tool_calls finding (M2 acceptance)"
```

---

## 验收标准(M2 完成的定义)

- [ ] `npx vitest run` 全绿(约 35 用例,见 Task 11 Step 4)。
- [ ] `npx tsc --noEmit` 无错。
- [ ] 缺 key / 无参数冒烟给清晰报错并退出 1。
- [ ] 真网络:模型能请求 `read_file`/`list_dir`,codeds 执行并回灌,模型据此回答(Task 12 Step 1)。
- [ ] §13 的 `parallel_tool_calls` 已由实测结论替换(接受+并行 / 接受+串行 / 已移除,三者之一)。
- [ ] M1 carry-over ①②(SSE `\r\n`、流末 flush)已落地并有测试覆盖。
- [ ] 所有外部 IO(env/fetch/stdout、fs 经 ctx)可注入或隔离,单测不触网。

## 给 M3 留的接口(本计划不实现,仅说明衔接点)

- `Tool.capability` / `Tool.approval` 已声明但未强制——M3 的审批门据此推导 Auto/Suggest/Required,并在 `registry.dispatch` 前插入审批与 **PathEscape**(把 `read_file`/`list_dir` 的路径锁在 workspaceRoot 内,拒绝 `..` 越界)。
- `executeToolCalls` 当前对所有工具一视同仁并发;M3 引入「Auto 立即并发、Required 挂起等审批」的分流(设计文档 §5/§12)。
- `runAgent` 的 `ctx` 之后会携带 mode(normal/plan);plan 模式禁写/执行类工具——M2 工具都是只读,天然兼容。
