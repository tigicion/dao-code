import { getBackend, type ObsSpan } from "./backend.js";
import { llmAttributes, cacheTag } from "./attrs.js";
import type {
  StreamChatOptions, StreamDelta, AssistantMessage, ToolCall, ToolMessage, Usage,
} from "../client/types.js";

const SPAN_OUTPUT = "lmnr.span.output"; // Laminar 约定的 span 输出属性键

function truncate(s: string, n = 2000): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

type StreamFn = (opts: StreamChatOptions) => AsyncGenerator<StreamDelta, AssistantMessage>;

/** LLM span:generator 手动管 span,迭代结束后写 token/output(不能用 observe,否则提前收尾)。 */
export function wrapStreamChat(inner: StreamFn): StreamFn {
  if (!getBackend()) return inner;
  return async function* (opts: StreamChatOptions): AsyncGenerator<StreamDelta, AssistantMessage> {
    const backend = getBackend();
    if (!backend) return yield* inner(opts); // 运行中被关(极边界):直接透传
    const span: ObsSpan = backend.startSpan({
      name: "llm.call", spanType: "LLM", input: opts.messages,
    });
    let usage: Usage | undefined;
    const orig = opts.onUsage;
    const patched: StreamChatOptions = {
      ...opts,
      onUsage: (u) => { usage = u; orig?.(u); }, // 截获 usage,不破坏原回调链
    };
    try {
      const msg = yield* inner(patched);          // 透传全部 delta 与返回值
      span.setAttributes(llmAttributes(opts.model, usage));
      const tag = cacheTag(usage);
      if (tag) span.setAttributes({ [`lmnr.association.properties.${tag}`]: 1 });
      span.setAttributes({ [SPAN_OUTPUT]: truncate(msg.content ?? "") });
      return msg;
    } finally {
      span.end();                                 // abort/异常也正确收尾
    }
  };
}

type RunTurnFn = (deps: any) => Promise<void>;

/** turn span:普通 async,用 withActive 让本回合内的 llm/tool span 都挂它下面。 */
export function wrapRunTurn(inner: RunTurnFn): RunTurnFn {
  if (!getBackend()) return inner;
  return async (deps: any): Promise<void> => {
    const backend = getBackend();
    if (!backend) return inner(deps);
    const span = backend.startSpan({
      name: "turn", spanType: "DEFAULT",
      sessionId: typeof deps?.sessionId === "string" ? deps.sessionId : undefined,
      metadata: {
        identity: deps?.identity ?? "main",
        depth: typeof deps?.depth === "number" ? deps.depth : 0,
      },
    });
    try {
      await backend.withActive(span, () => inner(deps));
    } finally {
      span.end();
    }
  };
}

type ToolExecFn = (
  toolCalls: ToolCall[], registry: unknown, ctx: unknown, gate: unknown,
) => Promise<ToolMessage[]>;

/** 每个 tool_call 一个 TOOL span;批量 await 后按 tool_call_id 配结果。
 *  注:工具在 executeToolCalls 内部并发/屏障执行,duration 为批级近似(不改核心文件的取舍)。 */
export function wrapToolExec(inner: ToolExecFn): ToolExecFn {
  if (!getBackend()) return inner;
  return async (toolCalls, registry, ctx, gate): Promise<ToolMessage[]> => {
    const backend = getBackend();
    if (!backend) return inner(toolCalls, registry, ctx, gate);
    const spans = new Map<string, ObsSpan>();
    for (const tc of toolCalls) {
      spans.set(tc.id, backend.startSpan({
        name: `tool.${tc.function.name}`, spanType: "TOOL",
        input: truncate(tc.function.arguments ?? ""),
      }));
    }
    try {
      const results = await inner(toolCalls, registry, ctx, gate);
      for (const r of results) {
        const span = spans.get(r.tool_call_id);
        if (span) span.setAttributes({ [SPAN_OUTPUT]: truncate(r.content ?? "") });
      }
      return results;
    } finally {
      for (const span of spans.values()) span.end();
    }
  };
}
