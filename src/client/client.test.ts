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

  it("throws on non-2xx responses", async () => {
    await expect(
      run(streamChat({ ...base, messages: [{ role: "user", content: "hi" }], fetchImpl: fakeFetch([], 401) })),
    ).rejects.toThrow(/401/);
  });
});
