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
