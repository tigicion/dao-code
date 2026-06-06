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

  // 空闲看门狗:连接挂起/模型停滞导致长时间收不到任何数据时,自动中断本次流并抛清晰错误。
  const idleMs = opts.idleTimeoutMs ?? (Number(process.env.DAO_STREAM_IDLE_MS) || 120000);
  const idleErrMsg = `模型流空闲超时(${Math.round(idleMs / 1000)}s 未收到数据),已停止本回合`;
  const maxRetries = opts.maxRetries ?? 2;
  const retryDelayMs = opts.retryDelayMs ?? 600;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  // abort(ESC/超时)判定:中断后 reader.read() reject AbortError——不上抛,优雅返回已累积部分。
  const isAbort = (e: unknown): boolean =>
    opts.signal?.aborted === true ||
    (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError"));
  // 可重试的网络瞬断(连接被关、重置、DNS 抖动等):产出内容前遇到则自动重试。
  const isRetryable = (e: unknown): boolean => {
    const m = e instanceof Error ? `${e.name} ${e.message}` : String(e);
    return /socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|closed unexpectedly|fetch failed|terminated|ENOTFOUND|EAI_AGAIN|network/i.test(m);
  };

  // 累积状态(每次尝试前重置——仅在尚未产出任何 delta 时才会重试)。
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

  let yieldedAny = false; // 是否已产出过 delta(产出后不再重试,避免重复内容)
  for (let attempt = 0; ; attempt++) {
    // 每次尝试独立的看门狗 + 累积状态(重试 = 从头重来)。
    content = "";
    toolAcc.length = 0;
    announced.clear();
    const watchdog = new AbortController();
    let idledOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { idledOut = true; watchdog.abort(); }, idleMs);
    };
    const fetchSignal = opts.signal ? AbortSignal.any([opts.signal, watchdog.signal]) : watchdog.signal;
    let buffer = "";
    try {
      armIdle(); // 连接/首字节阶段也纳入看门狗
      const res = await fetchImpl(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify(body),
        signal: fetchSignal,
      });
      if (!res.ok) {
        clearTimeout(idleTimer);
        const text = await res.text().catch(() => "");
        throw new Error(`DeepSeek API error ${res.status}: ${text}`);
      }
      if (!res.body) throw new Error("DeepSeek API returned an empty body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdle(); // 收到数据 → 重置看门狗
        buffer += decoder.decode(value, { stream: true });
        const { payloads, rest } = parseSSEChunk(buffer);
        buffer = rest;
        for (const payload of payloads) for (const d of processPayload(payload)) { yieldedAny = true; yield d; }
      }
      // 流末 flush:处理未以 \n\n 收尾的最后一个事件。
      buffer += decoder.decode();
      if (buffer.trim()) {
        const { payloads } = parseSSEChunk(buffer.endsWith("\n\n") ? buffer : buffer + "\n\n");
        for (const payload of payloads) for (const d of processPayload(payload)) { yieldedAny = true; yield d; }
      }
      clearTimeout(idleTimer);
      break; // 成功
    } catch (err) {
      clearTimeout(idleTimer);
      if (idledOut) throw new Error(idleErrMsg); // 停滞超时:清晰错误
      if (isAbort(err)) break; // ESC/取消:优雅返回已累积部分
      if (isRetryable(err)) {
        // 产出内容前的瞬断 → 退避重试;重试耗尽且无内容 → 抛清晰错误(不抛 undici 原始报错);
        // 已产出内容的中途断开 → 返回部分(不重试,避免重复)。
        if (!yieldedAny && attempt < maxRetries) { await sleep(retryDelayMs * (attempt + 1)); continue; }
        if (!yieldedAny) throw new Error(`连接 DeepSeek 失败(已重试 ${maxRetries} 次,请检查网络后重试)`);
        break;
      }
      throw err; // 非可重试错误,原样上抛
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
