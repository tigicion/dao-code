# codeds M1 — Walking Skeleton 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通 codeds 最小竖切:发一条用户消息 → 调 DeepSeek 流式接口 → 实时打印 reasoning_content + content,一次性结束(无工具、无多轮)。

**Architecture:** 四层纯函数/可注入依赖的模块,自底向上:`config`(读环境) → `sse`(纯函数解析 SSE 分块) → `client`(async generator,注入 fetch,把 SSE 转成类型化 delta) → `runner`(组装 messages、消费 generator、流式打印)。所有外部 IO(env、fetch、stdout)都通过参数注入,保证单测不触网、不读真实环境。

**Tech Stack:** Node 20+,TypeScript(ESM),vitest(测试),tsx(运行),原生 `fetch` + `ReadableStream`(SSE)。无运行时第三方依赖。

参考设计文档:`docs/2026-06-04-deepseek-coding-agent-design.md`(§4 工具、§10 cache、§11 架构、§13 已验证的 API 事实)。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `package.json` | ESM 项目、脚本(test/dev/typecheck)、devDeps |
| `tsconfig.json` | TS 严格模式、ESM、`src` 编译配置 |
| `vitest.config.ts` | 测试配置(node 环境) |
| `src/config/config.ts` | 从注入的 env 对象读取并校验配置,返回 `Config` |
| `src/config/config.test.ts` | config 单测 |
| `src/client/sse.ts` | `parseSSEChunk` 纯函数:增量缓冲 → 完整 SSE 数据负载 |
| `src/client/sse.test.ts` | SSE 解析单测(含跨分块边界) |
| `src/client/types.ts` | `ChatMessage` / `StreamDelta` / `StreamChatOptions` 类型 |
| `src/client/client.ts` | `streamChat` async generator:注入 fetch,yield `StreamDelta` |
| `src/client/client.test.ts` | client 单测(假 fetch + 假 ReadableStream) |
| `src/runner.ts` | 一次性 runner:组 messages、消费 generator、流式写 stdout |
| `src/runner.test.ts` | runner 单测(注入假 streamChat + 假 writer) |
| `src/index.ts` | CLI 入口:读真实 env + 命令行参数,调 runner |

---

## Task 1: 项目脚手架

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: 创建 `package.json`**

```json
{
  "name": "codeds",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: 创建 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 创建 `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: 创建 `.gitignore`**

```
node_modules/
dist/
*.log
.env
```

- [ ] **Step 5: 安装依赖并验证 toolchain**

Run: `cd /Users/huaruoxu/ClaudeProject/career_plan/code/codeds && npm install && npx tsc --noEmit`
Expected: 安装成功;`tsc --noEmit` 无文件可编译时静默退出码 0(此时 `src` 还为空,允许)。

- [ ] **Step 6: 初始化 git 并提交**

Run:
```bash
cd /Users/huaruoxu/ClaudeProject/career_plan/code/codeds
git init
git add package.json tsconfig.json vitest.config.ts .gitignore package-lock.json
git commit -m "chore: scaffold codeds TS/ESM project with vitest"
```
Expected: 一个初始提交。(`node_modules/` 已被忽略。)

---

## Task 2: Config 加载器

**Files:**
- Create: `src/config/config.ts`
- Test: `src/config/config.test.ts`

**契约:** `loadConfig(env: Record<string, string | undefined>): Config`。缺 `DEEPSEEK_API_KEY` 抛错;`base_url` 默认 `https://api.deepseek.com`;默认模型 `deepseek-v4-pro`。

- [ ] **Step 1: 写失败测试**

```ts
// src/config/config.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("reads api key and applies defaults", () => {
    const cfg = loadConfig({ DEEPSEEK_API_KEY: "sk-test" });
    expect(cfg.apiKey).toBe("sk-test");
    expect(cfg.baseUrl).toBe("https://api.deepseek.com");
    expect(cfg.model).toBe("deepseek-v4-pro");
  });

  it("allows overriding base url and model", () => {
    const cfg = loadConfig({
      DEEPSEEK_API_KEY: "sk-test",
      DEEPSEEK_BASE_URL: "https://proxy.example.com",
      DEEPSEEK_MODEL: "deepseek-v4-flash",
    });
    expect(cfg.baseUrl).toBe("https://proxy.example.com");
    expect(cfg.model).toBe("deepseek-v4-flash");
  });

  it("throws a clear error when api key is missing", () => {
    expect(() => loadConfig({})).toThrow(/DEEPSEEK_API_KEY/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/config/config.test.ts`
Expected: FAIL —— 找不到模块 `./config.js`。

- [ ] **Step 3: 写最小实现**

```ts
// src/config/config.ts
export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("Missing DEEPSEEK_API_KEY (set it in your environment).");
  }
  return {
    apiKey,
    baseUrl: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    model: env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/config/config.test.ts`
Expected: PASS(3 个用例)。

- [ ] **Step 5: 提交**

```bash
git add src/config/config.ts src/config/config.test.ts
git commit -m "feat(config): load DeepSeek config from env with defaults"
```

---

## Task 3: SSE 分块解析器(纯函数)

**Files:**
- Create: `src/client/sse.ts`
- Test: `src/client/sse.test.ts`

**契约:** SSE 事件以 `\n\n` 分隔,每个事件含若干 `data: <payload>` 行。`parseSSEChunk(buffer)` 接收"已累积但可能不完整"的字符串,返回 `{ payloads: string[]; rest: string }`:`payloads` 是已完整事件里 `data:` 行的负载(去掉 `data: ` 前缀,可能是 `[DONE]`);`rest` 是尚未凑齐 `\n\n` 的残留,留给下一块拼接。纯函数,无状态。

- [ ] **Step 1: 写失败测试**

```ts
// src/client/sse.test.ts
import { describe, it, expect } from "vitest";
import { parseSSEChunk } from "./sse.js";

describe("parseSSEChunk", () => {
  it("extracts a single complete data payload", () => {
    const r = parseSSEChunk('data: {"a":1}\n\n');
    expect(r.payloads).toEqual(['{"a":1}']);
    expect(r.rest).toBe("");
  });

  it("extracts multiple events in one chunk", () => {
    const r = parseSSEChunk('data: {"a":1}\n\ndata: {"b":2}\n\n');
    expect(r.payloads).toEqual(['{"a":1}', '{"b":2}']);
    expect(r.rest).toBe("");
  });

  it("keeps an incomplete trailing event in rest", () => {
    const r = parseSSEChunk('data: {"a":1}\n\ndata: {"b"');
    expect(r.payloads).toEqual(['{"a":1}']);
    expect(r.rest).toBe('data: {"b"');
  });

  it("passes through the [DONE] sentinel as a payload", () => {
    const r = parseSSEChunk("data: [DONE]\n\n");
    expect(r.payloads).toEqual(["[DONE]"]);
  });

  it("ignores non-data lines (comments, empty)", () => {
    const r = parseSSEChunk(": keep-alive\n\ndata: {\"a\":1}\n\n");
    expect(r.payloads).toEqual(['{"a":1}']);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/client/sse.test.ts`
Expected: FAIL —— 找不到模块 `./sse.js`。

- [ ] **Step 3: 写最小实现**

```ts
// src/client/sse.ts
export interface SSEParseResult {
  payloads: string[];
  rest: string;
}

// SSE 事件以空行(\n\n)分隔。把已完整的事件解析出来,残留留给下一块。
export function parseSSEChunk(buffer: string): SSEParseResult {
  const parts = buffer.split("\n\n");
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

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/client/sse.test.ts`
Expected: PASS(5 个用例)。

- [ ] **Step 5: 提交**

```bash
git add src/client/sse.ts src/client/sse.test.ts
git commit -m "feat(client): pure SSE chunk parser with cross-chunk buffering"
```

---

## Task 4: Client 类型定义

**Files:**
- Create: `src/client/types.ts`

无独立测试(纯类型;被 Task 5/6 的测试覆盖)。

- [ ] **Step 1: 写类型**

```ts
// src/client/types.ts

// 发给 DeepSeek 的对话消息(M1 只用到 system/user/assistant)。
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// streamChat 逐块 yield 的类型化增量。M1 只关心 reasoning 与 content 文本。
export type StreamDelta =
  | { kind: "reasoning"; text: string }
  | { kind: "content"; text: string };

export interface StreamChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  // 注入 fetch,便于测试;默认用全局 fetch。
  fetchImpl?: typeof fetch;
  // 透传给 API 的额外字段(如 thinking、reasoning_effort),M1 先留口不强制。
  extra?: Record<string, unknown>;
}
```

- [ ] **Step 2: typecheck 通过**

Run: `npx tsc --noEmit`
Expected: 退出码 0,无类型错误。

- [ ] **Step 3: 提交**

```bash
git add src/client/types.ts
git commit -m "feat(client): chat message and stream delta types"
```

---

## Task 5: DeepSeek 流式 client

**Files:**
- Create: `src/client/client.ts`
- Test: `src/client/client.test.ts`

**契约:** `streamChat(opts): AsyncGenerator<StreamDelta>`。向 `${baseUrl}/chat/completions` POST(`stream: true`、`Authorization: Bearer`),读取 `response.body`,用 `parseSSEChunk` 增量解析,对每个非 `[DONE]` 负载 JSON.parse,从 `choices[0].delta` 取 `reasoning_content`→yield reasoning、`content`→yield content。HTTP 非 2xx 抛含状态码与响应体的错误。

> 测试用假 fetch:返回一个 `Response`,其 `body` 是把若干 SSE 字符串编码成 `Uint8Array` 的 `ReadableStream`。辅助函数 `sseStream(chunks)` 构造它。

- [ ] **Step 1: 写失败测试**

```ts
// src/client/client.test.ts
import { describe, it, expect } from "vitest";
import { streamChat } from "./client.js";
import type { StreamDelta } from "./types.js";

// 把字符串数组做成一个流式 Response 的 body(逐块 enqueue,模拟网络分片)。
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]!));
      } else {
        controller.close();
      }
    },
  });
}

function fakeFetch(chunks: string[], status = 200): typeof fetch {
  return (async () =>
    new Response(status === 200 ? sseStream(chunks) : "boom", {
      status,
    })) as unknown as typeof fetch;
}

async function collect(gen: AsyncGenerator<StreamDelta>): Promise<StreamDelta[]> {
  const out: StreamDelta[] = [];
  for await (const d of gen) out.push(d);
  return out;
}

describe("streamChat", () => {
  it("yields reasoning then content deltas", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const deltas = await collect(
      streamChat({
        baseUrl: "https://x",
        apiKey: "sk",
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
        fetchImpl: fakeFetch(chunks),
      }),
    );
    expect(deltas).toEqual([
      { kind: "reasoning", text: "think" },
      { kind: "content", text: "hello" },
    ]);
  });

  it("reassembles a payload split across network chunks", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"con',
      'tent":"hi"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const deltas = await collect(
      streamChat({
        baseUrl: "https://x",
        apiKey: "sk",
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
        fetchImpl: fakeFetch(chunks),
      }),
    );
    expect(deltas).toEqual([{ kind: "content", text: "hi" }]);
  });

  it("throws on non-2xx responses", async () => {
    await expect(
      collect(
        streamChat({
          baseUrl: "https://x",
          apiKey: "sk",
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "hi" }],
          fetchImpl: fakeFetch([], 401),
        }),
      ),
    ).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/client/client.test.ts`
Expected: FAIL —— 找不到模块 `./client.js`。

- [ ] **Step 3: 写最小实现**

```ts
// src/client/client.ts
import { parseSSEChunk } from "./sse.js";
import type { StreamChatOptions, StreamDelta } from "./types.js";

export async function* streamChat(
  opts: StreamChatOptions,
): AsyncGenerator<StreamDelta> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${opts.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      stream: true,
      ...opts.extra,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`DeepSeek API error ${res.status}: ${body}`);
  }
  if (!res.body) {
    throw new Error("DeepSeek API returned an empty body");
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
      if (payload === "[DONE]" || payload === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue; // 半个 JSON 不该出现(已按 \n\n 切),保险跳过
      }
      const delta = (parsed as any)?.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        yield { kind: "reasoning", text: delta.reasoning_content };
      }
      if (typeof delta.content === "string" && delta.content) {
        yield { kind: "content", text: delta.content };
      }
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/client/client.test.ts`
Expected: PASS(3 个用例)。

- [ ] **Step 5: 提交**

```bash
git add src/client/client.ts src/client/client.test.ts
git commit -m "feat(client): streaming DeepSeek chat client over injected fetch"
```

---

## Task 6: 一次性 Runner

**Files:**
- Create: `src/runner.ts`
- Test: `src/runner.test.ts`

**契约:** `runOnce(deps)`:组 messages(可选 system + 一条 user),消费注入的 `streamChat`,把 reasoning 与 content 分别写到注入的 writer。reasoning 加灰色/前缀以便和正文区分(M1 用纯文本前缀,不引渲染库)。返回累计的 `{ reasoning, content }` 便于断言。

> 把 `streamChat` 与 writer 都注入,测试不触网、不写真实 stdout。

- [ ] **Step 1: 写失败测试**

```ts
// src/runner.test.ts
import { describe, it, expect } from "vitest";
import { runOnce } from "./runner.js";
import type { StreamDelta } from "./client/types.js";

async function* fakeStream(): AsyncGenerator<StreamDelta> {
  yield { kind: "reasoning", text: "let me think" };
  yield { kind: "content", text: "Hello" };
  yield { kind: "content", text: ", world" };
}

describe("runOnce", () => {
  it("streams reasoning and content to the writer and returns accumulated text", async () => {
    const written: string[] = [];
    const result = await runOnce({
      prompt: "hi",
      streamChat: () => fakeStream(),
      write: (s) => written.push(s),
    });

    expect(result.reasoning).toBe("let me think");
    expect(result.content).toBe("Hello, world");
    // 正文两块应原样落到 writer
    expect(written.join("")).toContain("Hello, world");
    // reasoning 也应出现在输出里
    expect(written.join("")).toContain("let me think");
  });

  it("passes the user prompt through as a user message", async () => {
    let seenMessages: unknown;
    await runOnce({
      prompt: "what is 2+2",
      streamChat: (opts) => {
        seenMessages = opts.messages;
        return fakeStream();
      },
      write: () => {},
    });
    expect(seenMessages).toEqual([{ role: "user", content: "what is 2+2" }]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/runner.test.ts`
Expected: FAIL —— 找不到模块 `./runner.js`。

- [ ] **Step 3: 写最小实现**

```ts
// src/runner.ts
import type { ChatMessage, StreamChatOptions, StreamDelta } from "./client/types.js";

export interface RunOnceDeps {
  prompt: string;
  // 注入流式函数,签名与真实 streamChat 兼容(测试传假实现)。
  streamChat: (opts: StreamChatOptions) => AsyncGenerator<StreamDelta>;
  // 注入 writer(默认 process.stdout.write)。
  write: (s: string) => void;
  // 真实调用时由入口填充;测试可省略(假 streamChat 不读它们)。
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  system?: string;
}

export interface RunOnceResult {
  reasoning: string;
  content: string;
}

export async function runOnce(deps: RunOnceDeps): Promise<RunOnceResult> {
  const messages: ChatMessage[] = [];
  if (deps.system) messages.push({ role: "system", content: deps.system });
  messages.push({ role: "user", content: deps.prompt });

  const gen = deps.streamChat({
    baseUrl: deps.baseUrl ?? "",
    apiKey: deps.apiKey ?? "",
    model: deps.model ?? "",
    messages,
  });

  let reasoning = "";
  let content = "";
  let inReasoning = false;
  for await (const delta of gen) {
    if (delta.kind === "reasoning") {
      if (!inReasoning) {
        deps.write("\x1b[90m"); // 灰色起始(reasoning)
        inReasoning = true;
      }
      reasoning += delta.text;
      deps.write(delta.text);
    } else {
      if (inReasoning) {
        deps.write("\x1b[0m\n\n"); // 关灰色,正文换行起
        inReasoning = false;
      }
      content += delta.text;
      deps.write(delta.text);
    }
  }
  if (inReasoning) deps.write("\x1b[0m");
  deps.write("\n");
  return { reasoning, content };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/runner.test.ts`
Expected: PASS(2 个用例)。

- [ ] **Step 5: 提交**

```bash
git add src/runner.ts src/runner.test.ts
git commit -m "feat(runner): one-shot run streaming reasoning + content to writer"
```

---

## Task 7: CLI 入口

**Files:**
- Create: `src/index.ts`

无单测(纯组装/副作用;逻辑已被 Task 2/5/6 覆盖)。手动冒烟验证。

- [ ] **Step 1: 写入口**

```ts
// src/index.ts
import { loadConfig } from "./config/config.js";
import { streamChat } from "./client/client.js";
import { runOnce } from "./runner.js";

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

  await runOnce({
    prompt,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    streamChat,
    write: (s) => process.stdout.write(s),
  });
}

main().catch((err) => {
  console.error("\n" + (err as Error).message);
  process.exit(1);
});
```

- [ ] **Step 2: typecheck 全量通过**

Run: `npx tsc --noEmit`
Expected: 退出码 0,无类型错误。

- [ ] **Step 3: 全量测试通过**

Run: `npx vitest run`
Expected: 所有测试文件 PASS(config 3 + sse 5 + client 3 + runner 2 = 13 用例)。

- [ ] **Step 4: 缺 key 时的冒烟(不触网)**

Run: `DEEPSEEK_API_KEY= npm run dev -- "hello"`
Expected: 打印 `Missing DEEPSEEK_API_KEY ...` 并以退出码 1 结束。

- [ ] **Step 5: 真实冒烟(需有效 key,会触网+计费,人工执行)**

Run: `DEEPSEEK_API_KEY=<你的key> npm run dev -- "用一句话介绍你自己"`
Expected: 先以灰色流式打印一段 reasoning,空行后流式打印正文,最后换行退出。
> 若 reasoning 不出现:DeepSeek 默认 thinking=enabled 应有 `reasoning_content`;如为空,记录现象,留待 M5 接 `/think` 时排查(不阻塞 M1)。

- [ ] **Step 6: 提交**

```bash
git add src/index.ts
git commit -m "feat: CLI entry wiring config + client + runner for one-shot run"
```

---

## 验收标准(M1 完成的定义)

- [ ] `npx vitest run` 全绿(13 用例)。
- [ ] `npx tsc --noEmit` 无错。
- [ ] 缺 key 冒烟给出清晰报错并退出码 1。
- [ ] 真实冒烟能流式打印 reasoning + content(有有效 key 时)。
- [ ] 所有外部 IO(env / fetch / stdout)均经注入,测试不触网。

## 给 M2 留的接口(本计划不实现,仅说明衔接点)

- `ChatMessage.role` 之后要扩 `"tool"`,并加 `tool_calls` / `tool_call_id` 字段。
- `StreamDelta` 之后要加 `{ kind: "tool_call"; ... }` 变体;client 的 `delta.tool_calls` 累积逻辑在 M2 加。
- `runOnce` 的单轮会在 M2 被 `agent` 多轮 loop 取代;runner 的"消费 generator + 写 writer"这段可复用为渲染层。
- §10 cache 约束:M2 起 system prompt + 工具定义放最前且每轮字节一致——M1 的 messages 顺序(system→user)已与之兼容。
