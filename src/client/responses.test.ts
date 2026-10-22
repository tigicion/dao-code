import { describe, expect, it, vi } from "vitest";
import { streamChat } from "./client.js";
import type { AssistantMessage, ChatMessage, StreamDelta, Usage } from "./types.js";

const base = { baseUrl: "https://api.openai.com/v1", apiKey: "test", model: "gpt-6.1-sol" };
const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ciphertext" };
const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "Read", arguments: '{"path":"中文.ts"}' };
const answer = { type: "message", content: [{ type: "output_text", text: "完成" }] };
function events(output: Record<string, unknown>[], extra: Record<string, unknown>[] = []) {
  return [...extra, { type: "response.completed", response: { output, usage: {
    input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 80 },
  } } }];
}
function sse(values: Record<string, unknown>[]) {
  const bytes = new TextEncoder().encode(values.map(event => "event: " + event.type + "\r\ndata: " + JSON.stringify(event) + "\r\n\r\n").join(""));
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset >= bytes.length) controller.close();
    else { controller.enqueue(bytes.slice(offset, offset += 17)); }
  } }));
}
async function collect(generator: AsyncGenerator<StreamDelta, AssistantMessage>) {
  const deltas: StreamDelta[] = [];
  let next = await generator.next();
  while (!next.done) { deltas.push(next.value); next = await generator.next(); }
  return { message: next.value, deltas };
}

describe("GPT-6 Responses 协议", () => {
  it("流式工具参数、加密推理、图片与工具结果能完整往返,缓存用量归一化", async () => {
    const requests: { url: unknown; body: any }[] = [];
    const fetchImpl = vi.fn(async (url, init) => {
      requests.push({ url, body: JSON.parse(String(init?.body)) });
      return requests.length === 1 ? sse(events([reasoning, call], [
        { type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"path":' },
        { type: "response.function_call_arguments.delta", output_index: 1, delta: '"中文.ts"}' },
        { type: "response.output_item.done", output_index: 1, item: call },
      ])) : sse(events([answer], [{ type: "response.output_text.delta", delta: "完成" }]));
    }) as typeof fetch;
    const messages: ChatMessage[] = [{ role: "system", content: "系统" }, { role: "user", content: [
      { type: "text", text: "看图并读文件" }, { type: "image_url", image_url: { url: "data:image/png;base64,test" } },
    ] }];
    let used: Usage | undefined;
    const first = await collect(streamChat({ ...base, messages, fetchImpl, tools: [
      { type: "function", function: { name: "Read", description: "读取", parameters: { type: "object" } } },
    ], onUsage: value => { used = value; } }));
    expect(requests[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(requests[0]!.body).toMatchObject({ store: false, include: ["reasoning.encrypted_content"],
      tools: [{ type: "function", name: "Read", strict: false }] });
    expect(requests[0]!.body.input[1].content[1]).toEqual({ type: "input_image", image_url: "data:image/png;base64,test" });
    expect(first.message.tool_calls).toEqual([{ id: "call_1", type: "function", function: { name: "Read", arguments: call.arguments } }]);
    expect(first.message.responseItems).toEqual([reasoning]);
    expect(used).toMatchObject({ prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 });
    const second = await collect(streamChat({ ...base, fetchImpl, messages: [...messages, first.message,
      { role: "tool", tool_call_id: "call_1", content: "文件内容" }] }));
    expect(requests[1]!.body.input.slice(2)).toEqual([reasoning,
      { type: "function_call", call_id: "call_1", name: "Read", arguments: call.arguments },
      { type: "function_call_output", call_id: "call_1", output: "文件内容" }]);
    expect(second.message.content).toBe("完成");
    expect(second.deltas.filter(delta => delta.kind === "content")).toHaveLength(1);
  });
  it("官方三档均走 Responses,推理档与输出上限符合协议", async () => {
    for (const model of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]) {
      const fetchImpl = vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.max_output_tokens).toBe(128000);
        expect(body.reasoning.effort).toBe(model === "gpt-6-luna" ? "none" : "low");
        expect(body).not.toHaveProperty("max_tokens");
        return sse(events([answer]));
      }) as typeof fetch;
      expect((await collect(streamChat({ ...base, model, fetchImpl, messages: [{ role: "user", content: "你好" }],
        maxTokens: 256000, extra: { reasoning_effort: "none" } }))).message.content).toBe("完成");
    }
  });
  it("流式失败后复用非流式兜底,仍保留工具调用与推理项", async () => {
    let count = 0;
    const fetchImpl = vi.fn(async (_url, init) => {
      if (++count === 1) return new Response("busy", { status: 503 });
      expect(JSON.parse(String(init?.body)).stream).toBe(false);
      return Response.json({ status: "completed", output: [reasoning, call] });
    }) as typeof fetch;
    const result = await collect(streamChat({ ...base, fetchImpl, messages: [], maxRetries: 0 }));
    expect(result.message.tool_calls?.[0]?.id).toBe("call_1");
    expect(result.message.responseItems).toEqual([reasoning]);
  });
  it("自定义网关保持 Chat 协议且不会发送加密内部字段", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe("https://gateway.example/v1/chat/completions");
      const body = JSON.parse(String(init?.body));
      expect(body.messages[0]).not.toHaveProperty("responseItems");
      return new Response('data: {"choices":[{"delta":{"content":"网关回复"}}]}\n\ndata: [DONE]\n\n');
    }) as typeof fetch;
    const result = await collect(streamChat({ ...base, baseUrl: "https://gateway.example/v1", fetchImpl,
      messages: [{ role: "assistant", content: "此前回答", responseItems: [reasoning] }] }));
    expect(result.message.content).toBe("网关回复");
  });
  it("错误和无完成事件的断流不会被当成成功空回复", async () => {
    await expect(collect(streamChat({ ...base, messages: [], maxRetries: 0, fetchImpl: (async (_url, init) =>
      JSON.parse(String(init?.body)).stream
        ? sse([{ type: "response.failed", response: { error: { message: "bad request" } } }])
        : Response.json({ status: "failed", error: { message: "bad request" } })
    ) as typeof fetch }))).rejects.toThrow("bad request");
  });
});
