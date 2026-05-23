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
});
