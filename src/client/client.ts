import { parseSSEChunk } from "./sse.js";
import type {
  AssistantMessage,
  StreamChatOptions,
  StreamDelta,
  ToolCall,
  Usage,
} from "./types.js";

export async function* streamChat(
  opts: StreamChatOptions,
): AsyncGenerator<StreamDelta, AssistantMessage> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    // 流式下要拿 usage(含 cache 命中/未命中)必须显式开启,usage 在 [DONE] 前最后一个 chunk。
    stream_options: { include_usage: true },
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
    signal: opts.signal,
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
    // usage chunk(choices 常为空)在 [DONE] 前到达——先抓它再判 delta。
    if (parsed?.usage) opts.onUsage?.(parsed.usage as Usage);
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

  // abort(ESC/超时)判定:fetch 中断后 reader.read() 会 reject AbortError——
  // 不向上抛,跳出读取循环,返回此刻已累积的 content + tool_calls(部分消息),让上层优雅停。
  const isAbort = (e: unknown): boolean =>
    opts.signal?.aborted === true ||
    (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError"));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let aborted = false;
  try {
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
  } catch (err) {
    if (!isAbort(err)) throw err;
    aborted = true;
  }

  // 流末 flush:处理可能残留的、未以 \n\n 收尾的最后一个事件(被 abort 时跳过,残留可能是半个事件)。
  if (!aborted) {
    buffer += decoder.decode();
    if (buffer.trim()) {
      const { payloads } = parseSSEChunk(buffer.endsWith("\n\n") ? buffer : buffer + "\n\n");
      for (const payload of payloads) {
        for (const d of processPayload(payload)) yield d;
      }
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
