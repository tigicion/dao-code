import { describe, it, expect } from "vitest";
import { streamChat, isContextLengthError } from "./client.js";
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

  it("captures the final usage chunk (with cache hit/miss) via onUsage", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":50,"total_tokens":1050,"prompt_cache_hit_tokens":900,"prompt_cache_miss_tokens":100}}\n\n',
      "data: [DONE]\n\n",
    ];
    let seen: any;
    await run(
      streamChat({
        ...base,
        messages: [{ role: "user", content: "hi" }],
        onUsage: (u) => { seen = u; },
        fetchImpl: fakeFetch(chunks),
      }),
    );
    expect(seen).toMatchObject({ prompt_tokens: 1000, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 });
  });

  it("requests usage in the stream (stream_options.include_usage)", async () => {
    let sentBody: any;
    const capturingFetch = (async (_url: string, init: any) => {
      sentBody = JSON.parse(init.body);
      return new Response(sseStream(["data: [DONE]\n\n"]), { status: 200 });
    }) as unknown as typeof fetch;
    await run(streamChat({ ...base, messages: [{ role: "user", content: "hi" }], fetchImpl: capturingFetch }));
    expect(sentBody.stream_options).toEqual({ include_usage: true });
  });

  it("throws on non-2xx responses", async () => {
    await expect(
      run(streamChat({ ...base, messages: [{ role: "user", content: "hi" }], fetchImpl: fakeFetch([], 401) })),
    ).rejects.toThrow(/401/);
  });

  it("returns the partial assistant message when aborted mid-stream (does not throw)", async () => {
    const enc = new TextEncoder();
    const controller = new AbortController();
    // 流:先吐一个 content delta,然后一直挂起 → 给我们时间 abort。
    // abort 时把 reader 的 read() reject 成 AbortError(模拟 fetch 的中断行为)。
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
      },
      pull() {
        // 第二次 read():返回一个永不 resolve、但在 abort 时 reject 的 promise。
        return new Promise<void>((_, reject) => {
          controller.signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        });
      },
    });
    const abortingFetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

    const gen = streamChat({
      ...base,
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: abortingFetch,
      signal: controller.signal,
    });

    const deltas: StreamDelta[] = [];
    let r = await gen.next(); // 拿到第一个 content delta
    expect(r.done).toBe(false);
    deltas.push(r.value as StreamDelta);

    // 触发 abort,然后继续驱动生成器到结束——应正常返回部分消息,不抛错。
    controller.abort();
    let message: AssistantMessage | undefined;
    await expect(
      (async () => {
        r = await gen.next();
        while (!r.done) {
          deltas.push(r.value as StreamDelta);
          r = await gen.next();
        }
        message = r.value;
      })(),
    ).resolves.toBeUndefined();

    expect(deltas).toContainEqual({ kind: "content", text: "partial" });
    expect(message).toEqual({ role: "assistant", content: "partial" });
  });

  it("连接瞬断:首次 socket 错误自动重试,第二次成功", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) throw new Error("The socket connection was closed unexpectedly");
      return new Response(sseStream(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "data: [DONE]\n\n"]), { status: 200 });
    }) as unknown as typeof fetch;
    const { message } = await run(
      streamChat({ ...base, messages: [{ role: "user", content: "hi" }], fetchImpl, maxRetries: 2, retryDelayMs: 0 }),
    );
    expect(calls).toBe(2);
    expect(message).toEqual({ role: "assistant", content: "hi" });
  });

  it("连接持续失败:流式重试耗尽 + 非流式兜底也失败 → 抛清晰错误", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; throw new Error("fetch failed"); }) as unknown as typeof fetch;
    await expect(
      run(streamChat({ ...base, messages: [{ role: "user", content: "hi" }], fetchImpl, maxRetries: 2, retryDelayMs: 0 })),
    ).rejects.toThrow(/连接.*失败|重试|非流式/);
    expect(calls).toBe(4); // 1 + 2 流式重试 + 1 非流式兜底
  });

  it("流式持续失败 → 非流式兜底成功,返回完整消息", async () => {
    let streamCalls = 0, nonStreamCalls = 0;
    const fetchImpl = (async (_url: string, init: any) => {
      const b = JSON.parse(init.body);
      if (b.stream) { streamCalls++; throw new Error("fetch failed: ECONNRESET"); }
      nonStreamCalls++;
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "recovered" } }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    let seen: any;
    const { message, deltas } = await run(
      streamChat({ ...base, messages: [{ role: "user", content: "hi" }], fetchImpl, maxRetries: 1, retryDelayMs: 0, onUsage: (u) => { seen = u; } }),
    );
    expect(streamCalls).toBe(2); // 1 + 1 retry
    expect(nonStreamCalls).toBe(1);
    expect(message.content).toBe("recovered");
    expect(deltas).toContainEqual({ kind: "content", text: "recovered" }); // 兜底内容也显示
    expect(seen?.prompt_tokens).toBe(5); // 非流式 usage 也计入
  });

  it("非流式兜底也能恢复 tool_calls", async () => {
    const fetchImpl = (async (_url: string, init: any) => {
      const b = JSON.parse(init.body);
      if (b.stream) throw new Error("fetch failed");
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const { message, deltas } = await run(
      streamChat({ ...base, messages: [{ role: "user", content: "hi" }], fetchImpl, maxRetries: 0, retryDelayMs: 0 }),
    );
    expect(message.tool_calls?.[0]?.function.name).toBe("read_file");
    expect(deltas).toContainEqual({ kind: "tool_call", index: 0, name: "read_file" });
  });

  it("503/529 过载:作为可重试处理(走重试/兜底)", async () => {
    let calls = 0;
    const fetchImpl = (async (_url: string, init: any) => {
      const b = JSON.parse(init.body);
      calls++;
      if (b.stream) return new Response("overloaded", { status: 529 });
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const { message } = await run(
      streamChat({ ...base, messages: [{ role: "user", content: "hi" }], fetchImpl, maxRetries: 1, retryDelayMs: 0 }),
    );
    expect(message.content).toBe("ok"); // 529 流式失败 → 非流式兜底
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("上下文超限错误直接上抛(交给上层反应式压缩),不重试不兜底", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response("This model's maximum context length is 65536 tokens", { status: 400 }); }) as unknown as typeof fetch;
    await expect(
      run(streamChat({ ...base, messages: [{ role: "user", content: "hi" }], fetchImpl, maxRetries: 2, retryDelayMs: 0 })),
    ).rejects.toThrow(/context length/i);
    expect(calls).toBe(1); // 致命:不重试、不兜底
  });

  it("max_output_tokens 截断 → 续写补全(finish_reason=length 触发,拼接完整)", async () => {
    let streamCalls = 0, contCalls = 0;
    const fetchImpl = (async (_url: string, init: any) => {
      const b = JSON.parse(init.body);
      if (b.stream) {
        streamCalls++;
        return new Response(sseStream([
          'data: {"choices":[{"delta":{"content":"前半"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
          "data: [DONE]\n\n",
        ]), { status: 200 });
      }
      contCalls++; // 非流式续写
      return new Response(JSON.stringify({ choices: [{ message: { content: "后半" }, finish_reason: "stop" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const { message, deltas } = await run(
      streamChat({ ...base, messages: [{ role: "user", content: "写长文" }], fetchImpl }),
    );
    expect(streamCalls).toBe(1);
    expect(contCalls).toBe(1); // 续写一次
    expect(message.content).toBe("前半后半"); // 拼接完整
    expect(deltas).toContainEqual({ kind: "content", text: "后半" });
  });

  it("背景查询遇 529 → 立即上抛,不重试/不兜底", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response("overloaded", { status: 529 }); }) as unknown as typeof fetch;
    await expect(
      run(streamChat({ ...base, messages: [{ role: "user", content: "hi" }], fetchImpl, maxRetries: 3, retryDelayMs: 0, background: true })),
    ).rejects.toThrow(/529/);
    expect(calls).toBe(1); // 背景 529:零重试、零兜底
  });

  it("Retry-After:429 给 0s → 立即重试成功(不等固定退避)", async () => {
    let calls = 0;
    const fetchImpl = (async (_url: string, init: any) => {
      const b = JSON.parse(init.body); calls++;
      if (b.stream && calls === 1) return new Response("rl", { status: 429, headers: { "retry-after": "0" } });
      if (b.stream) return new Response(sseStream(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"]), { status: 200 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const { message } = await run(
      streamChat({ ...base, messages: [{ role: "user", content: "hi" }], fetchImpl, maxRetries: 2, retryDelayMs: 5000 }),
    );
    expect(message.content).toBe("ok"); // retry-after:0 → 立即重试,没卡 5s
  }, 2000);

  it("isContextLengthError 识别上下文溢出消息", () => {
    expect(isContextLengthError(new Error("maximum context length is 65536 tokens"))).toBe(true);
    expect(isContextLengthError(new Error("prompt is too long"))).toBe(true);
    expect(isContextLengthError(new Error("ECONNRESET"))).toBe(false);
  });

  it("流中途断开:返回已累积部分,不抛错、不重试", async () => {
    const enc = new TextEncoder();
    let calls = 0;
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"part"}}]}\n\n')); },
      pull() { return Promise.reject(new Error("The socket connection was closed unexpectedly")); },
    });
    const fetchImpl = (async () => { calls++; return new Response(body, { status: 200 }); }) as unknown as typeof fetch;
    const { message } = await run(
      streamChat({ ...base, messages: [{ role: "user", content: "hi" }], fetchImpl, maxRetries: 2, retryDelayMs: 0 }),
    );
    expect(message.content).toBe("part");
    expect(calls).toBe(1); // 已产出内容 → 不重试
  });

  it("aborts with a clear idle-timeout error when the stream stalls", async () => {
    const enc = new TextEncoder();
    let fetchSignal: AbortSignal | undefined;
    // 流:吐一个 chunk,之后 read() 永不 resolve;但若传入的 signal abort 则 reject(模拟看门狗中断连接)。
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
      },
      pull() {
        return new Promise<void>((_, reject) => {
          fetchSignal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        });
      },
    });
    const stallingFetch = (async (_url: string, init: any) => {
      fetchSignal = init.signal;
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      run(
        streamChat({
          ...base,
          messages: [{ role: "user", content: "hi" }],
          fetchImpl: stallingFetch,
          idleTimeoutMs: 50,
        }),
      ),
    ).rejects.toThrow(/空闲超时/);
  }, 2000);
});
