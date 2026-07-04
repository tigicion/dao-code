import { describe, it, expect, beforeEach, vi } from "vitest";
import { setBackend, setObsSession } from "./backend.js";
import type { ObsBackend, ObsSpan } from "./backend.js";
import { wrapStreamChat, wrapRunTurn, wrapToolExec } from "./wrap.js";
import type { StreamChatOptions, AssistantMessage, StreamDelta, ToolCall, ToolMessage } from "../client/types.js";

// 记录型 fake:每个 span 记 attrs 与 end 调用。
function makeFake() {
  const spans: { name: string; spanType: string; input?: unknown; sessionId?: string; attrs: Record<string, unknown>; ended: boolean }[] = [];
  const backend: ObsBackend = {
    startSpan(o) {
      const rec = { name: o.name, spanType: o.spanType, input: o.input, sessionId: o.sessionId, attrs: {} as Record<string, unknown>, ended: false };
      spans.push(rec);
      const span: ObsSpan = {
        setAttributes(a) { Object.assign(rec.attrs, a); },
        end() { rec.ended = true; },
      };
      return span;
    },
    withActive: (_s, fn) => fn(),
    flush: async () => {},
  };
  return { backend, spans };
}

// 一个最小 streamChat:yield 两个 delta,回调 usage,return 最终消息。
async function* fakeStream(opts: StreamChatOptions): AsyncGenerator<StreamDelta, AssistantMessage> {
  yield { kind: "content", text: "he" };
  yield { kind: "content", text: "llo" };
  opts.onUsage?.({ prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_cache_hit_tokens: 80 });
  return { role: "assistant", content: "hello" } as AssistantMessage;
}

const baseOpts = (): StreamChatOptions => ({ baseUrl: "x", apiKey: "x", model: "deepseek-chat", messages: [] });

describe("wrapStreamChat", () => {
  beforeEach(() => setBackend(null));

  it("关闭时原样返回入参函数(引用相等)", () => {
    expect(wrapStreamChat(fakeStream)).toBe(fakeStream);
  });

  it("开启时:delta 全透传、迭代结束后写 token/model/output、span 收尾", async () => {
    const { backend, spans } = makeFake();
    setBackend(backend);
    const usageSpy = vi.fn();
    const gen = wrapStreamChat(fakeStream)({ ...baseOpts(), onUsage: usageSpy });
    const deltas: StreamDelta[] = [];
    let res = await gen.next();
    while (!res.done) { deltas.push(res.value); res = await gen.next(); }
    const final = res.value as AssistantMessage;

    expect(deltas.map((d) => (d as any).text).join("")).toBe("hello"); // 透传不变
    expect(final.content).toBe("hello");                                // 原回调链保留
    expect(usageSpy).toHaveBeenCalledOnce();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("llm.call");
    expect(spans[0]!.spanType).toBe("LLM");
    expect(spans[0]!.attrs["gen_ai.request.model"]).toBe("deepseek-chat");
    expect(spans[0]!.attrs["gen_ai.usage.input_tokens"]).toBe(100);
    expect(spans[0]!.attrs["llm.span.output" in spans[0]!.attrs ? "llm.span.output" : "lmnr.span.output"]).toBe("hello");
    expect(spans[0]!.ended).toBe(true);
  });

  it("迭代中途异常也 end span", async () => {
    const { backend, spans } = makeFake();
    setBackend(backend);
    async function* boom(): AsyncGenerator<StreamDelta, AssistantMessage> {
      yield { kind: "content", text: "x" };
      throw new Error("boom");
    }
    const gen = wrapStreamChat(boom as any)(baseOpts());
    await gen.next();
    await expect(gen.next()).rejects.toThrow("boom");
    expect(spans[0]!.ended).toBe(true);
  });
});

describe("wrapToolExec", () => {
  beforeEach(() => setBackend(null));
  const tc = (id: string, name: string): ToolCall => ({ id, type: "function", function: { name, arguments: "{}" } });

  it("关闭时原样返回", () => {
    const inner = async () => [];
    expect(wrapToolExec(inner as any)).toBe(inner);
  });

  it("每个工具一个 TOOL span,名 tool.<name>,按 id 配结果并收尾", async () => {
    const { backend, spans } = makeFake();
    setBackend(backend);
    const inner = async (calls: ToolCall[]): Promise<ToolMessage[]> =>
      calls.map((c) => ({ role: "tool", tool_call_id: c.id, content: `result-${c.id}` }));
    const out = await wrapToolExec(inner as any)([tc("a", "read_file"), tc("b", "edit")], {} as any, {} as any, {} as any);
    expect(out).toHaveLength(2);
    expect(spans.map((s) => s.name).sort()).toEqual(["tool.edit", "tool.read_file"]);
    expect(spans.every((s) => s.spanType === "TOOL" && s.ended)).toBe(true);
  });
});

describe("wrapRunTurn", () => {
  beforeEach(() => { setBackend(null); setObsSession(undefined); });
  it("关闭时原样返回", () => {
    const inner = async () => {};
    expect(wrapRunTurn(inner as any)).toBe(inner);
  });
  it("开启时建 turn span 并在 withActive 中执行 inner", async () => {
    const { backend, spans } = makeFake();
    setBackend(backend);
    let ran = false;
    await wrapRunTurn((async () => { ran = true; }) as any)({});
    expect(ran).toBe(true);
    expect(spans[0]!.name).toBe("turn");
    expect(spans[0]!.spanType).toBe("DEFAULT");
    expect(spans[0]!.ended).toBe(true);
  });
  it("turn span 带上 setObsSession 注入的 session id(而非 deps.sessionId)", async () => {
    const { backend, spans } = makeFake();
    setBackend(backend);
    setObsSession("20260704-093759-qse2");
    // deps 里给个不同的 sessionId,证明用的是 obs 通道而非 deps
    await wrapRunTurn((async () => {}) as any)({ sessionId: "从-deps-不该被用" });
    expect(spans[0]!.sessionId).toBe("20260704-093759-qse2");
  });
});
