import { getBackend, getObsSession, getObsMeta, type ObsSpan } from "./backend.js";
import { llmAttributes, cacheTag, cacheLow, TAGS_KEY } from "./attrs.js";
import { looksFailed } from "../tools/execute.js";
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
      // 用 Laminar 保留 tags(字符串数组)而非普通 association 属性,让 cache 命中/未命中在 UI tag 面可筛。
      if (tag) span.setAttributes({ [TAGS_KEY]: [tag] });
      // 异常事件:已建立上下文却命中率异常低 → 疑似服务端缓存驱逐。
      const low = cacheLow(usage);
      if (low) backend.event("cache_low", { ...low, model: opts.model });
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
    const identity = deps?.identity ?? "main";
    const depth = typeof deps?.depth === "number" ? deps.depth : 0;
    const span = backend.startSpan({
      name: "turn", spanType: "DEFAULT",
      // session id 走独立通道(TurnDeps 无此字段);main() 建 store 后 setObsSession 注入。
      sessionId: getObsSession(),
      metadata: {
        ...getObsMeta(), // 进程级 trace 元数据(如 dao 版本号)
        identity, depth,
      },
    });
    // 异常事件:反思层是组合根注入的 deps.reflect,在此包一层——非空结论=触发了纠偏
    // (kind=challenger 卡住 / refocuser 长任务周期)。不改核心,只拦截注入点。
    const reflect = deps?.reflect;
    const wrapped = typeof reflect === "function"
      ? { ...deps, reflect: async (kind: "challenger" | "refocuser") => {
          const v = await reflect(kind);
          if (v != null) backend.event("reflect_fired", { kind, identity, depth });
          return v;
        } }
      : deps;
    try {
      await backend.withActive(span, () => inner(wrapped));
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
    const nameOf = new Map(toolCalls.map((tc) => [tc.id, tc.function.name]));
    try {
      const results = await inner(toolCalls, registry, ctx, gate);
      for (const r of results) {
        const span = spans.get(r.tool_call_id);
        if (span) span.setAttributes({ [SPAN_OUTPUT]: truncate(r.content ?? "") });
        // 异常事件:复用核心的规范失败判定(非零退出/超时/中断/Error);子代理失败也以 Task 结果冒出,一并覆盖。
        if (looksFailed(r.content ?? "")) backend.event("tool_error", { tool: nameOf.get(r.tool_call_id) ?? "?" });
      }
      return results;
    } finally {
      for (const span of spans.values()) span.end();
    }
  };
}
