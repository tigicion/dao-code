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
