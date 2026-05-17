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
}

// 驱动一轮 streamChat:渲染 delta,返回拼好的 assistant 消息。
async function renderTurn(
  gen: AsyncGenerator<StreamDelta, AssistantMessage>,
  write: (s: string) => void,
): Promise<AssistantMessage> {
  let inReasoning = false;
  let r = await gen.next();
  while (!r.done) {
    const d = r.value;
    if (d.kind === "reasoning") {
      if (!inReasoning) {
        write("\x1b[90m");
        inReasoning = true;
      }
      write(d.text);
    } else if (d.kind === "content") {
      if (inReasoning) {
        write("\x1b[0m\n\n");
        inReasoning = false;
      }
      write(d.text);
    } else {
      // tool_call
      if (inReasoning) {
        write("\x1b[0m\n");
        inReasoning = false;
      }
      write(`\n→ ${d.name}\n`);
    }
    r = await gen.next();
  }
  if (inReasoning) write("\x1b[0m");
  write("\n");
  return r.value;
}

// 在已有的 session.messages 上跑一个用户回合,直到模型不再请求工具。
export async function runTurn(deps: TurnDeps): Promise<void> {
  const { session } = deps;
  const maxTurns = deps.maxTurns ?? 25;
  for (let t = 0; t < maxTurns; t++) {
    const tools = apiToolsForMode(deps.registry, session.mode);
    const gen = deps.streamChat({
      baseUrl: deps.config.baseUrl,
      apiKey: deps.config.apiKey,
      model: session.model,
      messages: session.messages,
      ...(tools.length > 0 ? { tools, parallelToolCalls: true } : {}),
    });
    const assistant = await renderTurn(gen, deps.write);
    session.messages.push(assistant);
    if (!assistant.tool_calls || assistant.tool_calls.length === 0) return;
    const toolMessages = await deps.executeToolCalls(assistant.tool_calls, deps.registry, deps.ctx, deps.gate);
    session.messages.push(...toolMessages);
  }
  deps.write("\n[已达最大轮数,停止]\n");
}
