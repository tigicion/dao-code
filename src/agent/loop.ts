import type {
  AssistantMessage,
  StreamChatOptions,
  StreamDelta,
  ToolCall,
  ToolMessage,
} from "../client/types.js";
import type { ToolContext } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ApprovalGate } from "../approval/types.js";
import type { Session } from "../session/session.js";
import { apiToolsForMode } from "../tools/tools_for_mode.js";
import { renderStream } from "../tui/render.js";

export interface TurnDeps {
  session: Session;
  config: { baseUrl: string; apiKey: string };
  registry: ToolRegistry;
  ctx: ToolContext;
  gate: ApprovalGate;
  streamChat: (opts: StreamChatOptions) => AsyncGenerator<StreamDelta, AssistantMessage>;
  executeToolCalls: (
    toolCalls: ToolCall[],
    registry: ToolRegistry,
    ctx: ToolContext,
    gate: ApprovalGate,
  ) => Promise<ToolMessage[]>;
  write: (s: string) => void;
  maxTurns?: number;
  // 中途取消信号(ESC/超时):透传给 streamChat 与工具 ctx;abort 后本回合优雅停止。
  signal?: AbortSignal;
}

// 在已有的 session.messages 上跑一个用户回合,直到模型不再请求工具。
export async function runTurn(deps: TurnDeps): Promise<void> {
  const { session, signal } = deps;
  // 工具 ctx 透传取消信号(exec_shell 据此 SIGTERM);不改原 ctx 引用,按需补 signal。
  const toolCtx = signal ? { ...deps.ctx, signal } : deps.ctx;
  const maxTurns = deps.maxTurns ?? (Number(process.env.CODEDS_MAX_TURNS) || 50);
  for (let t = 0; t < maxTurns; t++) {
    if (signal?.aborted) return; // 上一轮工具执行后被取消,直接收尾
    const tools = apiToolsForMode(deps.registry, session.mode);
    const gen = deps.streamChat({
      baseUrl: deps.config.baseUrl,
      apiKey: deps.config.apiKey,
      model: session.model,
      messages: session.messages,
      ...(tools.length > 0 ? { tools, parallelToolCalls: true } : {}),
      // agent 类客户端默认用最高思考强度(官方对 Claude Code/OpenCode 类亦自动升到 max)。
      // 可用 CODEDS_REASONING_EFFORT 覆盖(实验:max 可能放大"过度推敲、到了正解不下手")。
      // 思考模式下 temperature/top_p 无效,故不设采样参数。
      extra: { reasoning_effort: process.env.CODEDS_REASONING_EFFORT || "max" },
      onUsage: (u) => session.addUsage(u),
      signal,
    });
    const assistant = await renderStream(gen, deps.write);
    session.messages.push(assistant);
    // 流被 abort:streamChat 返回的是部分消息,已入库;不再发起工具执行,优雅停止。
    if (signal?.aborted) return;
    if (!assistant.tool_calls || assistant.tool_calls.length === 0) return;

    if (session.mode === "plan") {
      // plan 模式的结构性强制:系统 prompt 仍列出全部工具,模型可能调用写/执行工具,
      // 但它们不在本轮允许表里——直接拒绝执行(不派发、不弹审批),回一条"不可用"消息。
      const allowed = new Set(tools.map((t) => t.function.name));
      const runnable = assistant.tool_calls.filter((tc) => allowed.has(tc.function.name));
      for (const tc of assistant.tool_calls) {
        if (!allowed.has(tc.function.name)) deps.write(`\n[plan 模式:拒绝 ${tc.function.name}]\n`);
      }
      const ran = runnable.length
        ? await deps.executeToolCalls(runnable, deps.registry, toolCtx, deps.gate)
        : [];
      const byId = new Map(ran.map((m) => [m.tool_call_id, m]));
      session.messages.push(
        ...assistant.tool_calls.map((tc) =>
          byId.get(tc.id) ?? {
            role: "tool" as const,
            tool_call_id: tc.id,
            content: `工具 ${tc.function.name} 在 plan 模式下不可用(只读+提方案)。如需修改请让用户切回 normal 模式。`,
          },
        ),
      );
    } else {
      const toolMessages = await deps.executeToolCalls(assistant.tool_calls, deps.registry, toolCtx, deps.gate);
      session.messages.push(...toolMessages);
    }
  }
  deps.write("\n[已达最大轮数,停止]\n");
}
