import { parseSSEChunk } from "./sse.js";

// 将 Responses 协议适配为现有 Chat 流,复用重试、取消、空闲看门狗和截断恢复。
// 仅官方 OpenAI 的 GPT-6 使用;自定义网关保持原有协议。
export function usesResponses(baseUrl: string, model: string): boolean {
  return baseUrl.replace(/\/+$/, "") === "https://api.openai.com/v1" && /^gpt-6(?:[.-]|$)/i.test(model);
}

type Item = Record<string, any>;

function inputMessages(messages: Item[]): Item[] {
  return messages.flatMap((message): Item[] => {
    if (message.role === "tool") {
      return [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content }];
    }
    const items: Item[] = [];
    if (message.role === "assistant") {
      items.push(...(message.responseItems ?? []).filter((item: Item) => item.type === "reasoning"));
      if (message.content) items.push({ role: "assistant", content: message.content });
      for (const call of message.tool_calls ?? []) {
        items.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
      return items;
    }
    const content = Array.isArray(message.content)
      ? message.content.map((part: Item) => part.type === "image_url"
        ? { type: "input_image", image_url: part.image_url.url }
        : { type: "input_text", text: part.text })
      : message.content;
    return [{ role: message.role, content }];
  });
}

function usage(raw: Item) {
  return {
    prompt_tokens: raw.input_tokens, completion_tokens: raw.output_tokens, total_tokens: raw.total_tokens,
    prompt_tokens_details: raw.input_tokens_details,
  };
}

function message(output: Item[]) {
  const text = output.filter(item => item.type === "message")
    .flatMap(item => item.content ?? []).map(part => part.text ?? part.refusal ?? "").join("");
  const calls = output.filter(item => item.type === "function_call").map(item => ({
    id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments },
  }));
  return { content: text || null, tool_calls: calls.length ? calls : undefined,
    responseItems: output.filter(item => item.type === "reasoning") };
}

export function responsesFetch(fetchImpl: typeof fetch): typeof fetch {
  return (async (_url, init) => {
    const chat = JSON.parse(String(init?.body)) as Item;
    const effort = chat.reasoning_effort ?? (chat.thinking?.type === "disabled" ? "low" : "medium");
    const body: Item = {
      model: chat.model, input: inputMessages(chat.messages), stream: chat.stream,
      store: false, include: ["reasoning.encrypted_content"],
      max_output_tokens: Math.min(chat.max_completion_tokens ?? chat.max_tokens, 128_000),
      reasoning: { effort: effort === "minimal" || effort === "none" && /astra|6\.1-sol/.test(chat.model) ? "low" : effort },
      ...(chat.tools?.length ? { tools: chat.tools.map((tool: Item) => ({ type: "function", ...tool.function, strict: false })) } : {}),
      ...(chat.parallel_tool_calls !== undefined ? { parallel_tool_calls: chat.parallel_tool_calls } : {}),
      ...(chat.tool_choice !== undefined ? { tool_choice: chat.tool_choice } : {}),
      ...(chat.service_tier !== undefined ? { service_tier: chat.service_tier } : {}),
    };
    const response = await fetchImpl("https://api.openai.com/v1/responses", { ...init, body: JSON.stringify(body) });
    if (!response.ok || !response.body) return response;
    if (!chat.stream) {
      const data = await response.json() as Item;
      if (data.error || data.status === "failed") throw new Error(`Responses error: ${JSON.stringify(data.error)}`);
      return Response.json({ choices: [{ message: message(data.output ?? []),
        finish_reason: data.status === "incomplete" ? "length" : "stop" }], ...(data.usage ? { usage: usage(data.usage) } : {}) });
    }
    const encoder = new TextEncoder(), decoder = new TextDecoder();
    let buffer = "", completed = false, hadText = false;
    const calls = new Map<number, { name: string; args: string }>();
    const output = new Map<number, Item>();
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        drain(controller);
      },
      flush(controller) {
        buffer += decoder.decode() + "\n\n";
        drain(controller);
        if (!completed) throw new Error("Responses stream closed unexpectedly");
      },
    });
    function drain(controller: TransformStreamDefaultController<Uint8Array>) {
      const parsed = parseSSEChunk(buffer); buffer = parsed.rest;
      const emit = (value: Item) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      const delta = (value: Item) => emit({ choices: [{ delta: value }] });
      const call = (index: number, item: Item) => {
        if (!calls.has(index)) {
          calls.set(index, { name: item.name, args: "" });
          delta({ tool_calls: [{ index, id: item.call_id, function: { name: item.name, arguments: "" } }] });
        }
        const acc = calls.get(index)!;
        if (item.arguments && item.arguments.length > acc.args.length) {
          delta({ tool_calls: [{ index, function: { arguments: item.arguments.slice(acc.args.length) } }] });
          acc.args = item.arguments;
        }
      };
      for (const payload of parsed.payloads) {
        if (payload === "[DONE]") continue;
        const event = JSON.parse(payload) as Item;
        if (event.type === "response.output_item.added" && event.item.type === "function_call") call(event.output_index, event.item);
        else if (event.type === "response.function_call_arguments.delta") {
          const acc = calls.get(event.output_index);
          if (!acc) throw new Error("Responses 工具参数缺少对应调用");
          acc.args += event.delta;
          delta({ tool_calls: [{ index: event.output_index, function: { arguments: event.delta } }] });
        } else if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
          hadText = true; delta({ content: event.delta });
        } else if (event.type === "response.reasoning_summary_text.delta") delta({ reasoning_content: event.delta });
        else if (event.type === "response.output_item.done") {
          output.set(event.output_index, event.item);
          if (event.item.type === "function_call") call(event.output_index, event.item);
        } else if (event.type === "response.completed" || event.type === "response.incomplete") {
          completed = true;
          const data = event.response, items: Item[] = data.output ?? [...output.values()];
          items.forEach((item, index) => { if (item.type === "function_call") call(index, item); });
          const msg = message(items);
          if (!hadText && msg.content) delta({ content: msg.content });
          emit({ response_items: msg.responseItems, ...(data.usage ? { usage: usage(data.usage) } : {}),
            choices: [{ delta: {}, finish_reason: event.type === "response.incomplete" ? "length" : calls.size ? "tool_calls" : "stop" }] });
        } else if (event.type === "error" || event.type === "response.failed") {
          emit({ error: event.error ?? event.response?.error ?? { message: event.message ?? "Responses 请求失败" } });
        }
      }
    }
    return new Response(response.body.pipeThrough(transform), { status: response.status, headers: response.headers });
  }) as typeof fetch;
}
