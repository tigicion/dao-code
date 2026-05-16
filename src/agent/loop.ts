import type {
  AssistantMessage,
  ChatMessage,
  StreamChatOptions,
  StreamDelta,
  ToolCall,
  ToolMessage,
} from "../client/types.js";
import type { ToolContext, ToolDispatcher } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface AgentDeps {
  prompt: string;
  system?: string;
  config: { baseUrl: string; apiKey: string; model: string };
  registry: ToolRegistry;
  ctx: ToolContext;
  streamChat: (opts: StreamChatOptions) => AsyncGenerator<StreamDelta, AssistantMessage>;
  executeToolCalls: (
    toolCalls: ToolCall[],
    dispatcher: ToolDispatcher,
    ctx: ToolContext,
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

export async function runAgent(deps: AgentDeps): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  if (deps.system) messages.push({ role: "system", content: deps.system });
  messages.push({ role: "user", content: deps.prompt });

  const tools = deps.registry.toApiTools();
  const maxTurns = deps.maxTurns ?? 25;

  for (let turn = 0; turn < maxTurns; turn++) {
    const gen = deps.streamChat({
      ...deps.config,
      messages,
      tools,
      parallelToolCalls: true,
    });
    const assistant = await renderTurn(gen, deps.write);
    messages.push(assistant);

    if (!assistant.tool_calls || assistant.tool_calls.length === 0) {
      return messages;
    }

    const toolMessages = await deps.executeToolCalls(assistant.tool_calls, deps.registry, deps.ctx);
    messages.push(...toolMessages);
  }

  deps.write("\n[已达最大轮数,停止]\n");
  return messages;
}
