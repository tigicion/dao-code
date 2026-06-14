import { parseSSEChunk } from "./sse.js";
import type {
  AssistantMessage,
  StreamChatOptions,
  StreamDelta,
  ToolCall,
  Usage,
} from "./types.js";

// 可重试的 HTTP 状态(过载/网关/限流);其余 4xx(400/401/403)视为致命,不重试。
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

// 上下文超限类错误:重试/非流式都救不了,需上层做反应式压缩后重试。导出给 loop 判定。
export function isContextLengthError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /context length|maximum context|too many tokens|reduce the length|context_length_exceeded|prompt is too long|exceeds? the maximum|input is too long/i.test(m);
}

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
  // 可重试的网络瞬断(连接被关、重置、DNS 抖动等)或可重试 HTTP 状态:产出内容前遇到则自动重试。
  const isRetryable = (e: unknown): boolean => {
    if ((e as { retryableStatus?: boolean })?.retryableStatus === true) return true;
    const m = e instanceof Error ? `${e.name} ${e.message}` : String(e);
    return /socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|closed unexpectedly|fetch failed|terminated|ENOTFOUND|EAI_AGAIN|network/i.test(m);
  };

  // 非流式兜底:流式彻底失败且尚无产出时,改用一次性请求把这一回合跑完(长任务不因流式不稳而中断)。
  async function nonStreamingFallback(): Promise<AssistantMessage> {
    const nsBody: Record<string, unknown> = { ...body, stream: false };
    delete nsBody.stream_options;
    // 兜底也要有超时,否则停滞连接会让 res.json() 永久挂起。
    const fbTimeout = AbortSignal.timeout(idleMs);
    const fbSignal = opts.signal ? AbortSignal.any([opts.signal, fbTimeout]) : fbTimeout;
    const res = await fetchImpl(`${opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify(nsBody),
      signal: fbSignal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`DeepSeek API error ${res.status}: ${t}`);
    }
    const data: any = await res.json();
    if (data?.usage) opts.onUsage?.(data.usage as Usage);
    const msg = data?.choices?.[0]?.message ?? {};
    const tc: ToolCall[] = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.filter((t: any) => t?.function?.name).map((t: any) => ({ id: t.id ?? "", type: "function" as const, function: { name: t.function.name, arguments: t.function.arguments ?? "" } }))
      : [];
    return { role: "assistant", content: typeof msg.content === "string" && msg.content ? msg.content : null, ...(tc.length ? { tool_calls: tc } : {}) };
  }

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
        const e = new Error(`DeepSeek API error ${res.status}: ${text}`) as Error & { retryableStatus?: boolean };
        if (RETRYABLE_STATUS.has(res.status)) e.retryableStatus = true; // 过载/限流/网关 → 可重试 + 兜底
        throw e; // 其余(400 含上下文超限/401/403)致命:原样上抛,交给上层
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
      if (isAbort(err) && !idledOut) break; // ESC/用户取消:优雅返回已累积部分
      // 上下文超限是致命且可救(上层压缩后重试):立即上抛,不重试/不兜底。
      if (isContextLengthError(err)) throw err;
      if (idledOut && yieldedAny) throw new Error(idleErrMsg); // 停滞但已产出部分:清晰报错(保持原契约,避免半截工具调用)
      const recoverable = idledOut || isRetryable(err); // idle 停滞 / 瞬断 / 过载状态
      if (recoverable && yieldedAny) break; // 已产出内容的中途断开 → 返回部分(不重试,避免重复)
      if (recoverable) {
        // 尚无产出:先退避重试流式(带 jitter);重试耗尽 → 非流式兜底一次;仍失败 → 抛清晰错误。
        if (attempt < maxRetries) { await sleep(retryDelayMs * (attempt + 1) + Math.floor(Math.random() * 250)); continue; }
        try {
          const msg = await nonStreamingFallback();
          if (typeof msg.content === "string" && msg.content) yield { kind: "content", text: msg.content };
          if (msg.tool_calls) {
            for (let i = 0; i < msg.tool_calls.length; i++) {
              const tc = msg.tool_calls[i]!;
              if (tc.function.name) yield { kind: "tool_call", index: i, name: tc.function.name };
            }
          }
          return msg;
        } catch (e2) {
          if (isContextLengthError(e2)) throw e2; // 兜底时撞上下文超限 → 交给上层压缩
          throw new Error(idledOut ? idleErrMsg : `连接 DeepSeek 失败(流式重试 ${maxRetries} 次 + 非流式兜底均失败:${(e2 as Error).message})`);
        }
      }
      throw err; // 非可重试错误(致命),原样上抛
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
