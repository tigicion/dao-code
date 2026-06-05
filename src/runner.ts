import type { ChatMessage, StreamChatOptions, StreamDelta } from "./client/types.js";

export interface RunOnceDeps {
  prompt: string;
  // 注入流式函数,签名与真实 streamChat 兼容(测试传假实现)。
  streamChat: (opts: StreamChatOptions) => AsyncGenerator<StreamDelta>;
  // 注入 writer(默认 process.stdout.write)。
  write: (s: string) => void;
  // 真实调用时由入口填充;测试可省略(假 streamChat 不读它们)。
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  system?: string;
}

export interface RunOnceResult {
  reasoning: string;
  content: string;
}

export async function runOnce(deps: RunOnceDeps): Promise<RunOnceResult> {
  const messages: ChatMessage[] = [];
  if (deps.system) messages.push({ role: "system", content: deps.system });
  messages.push({ role: "user", content: deps.prompt });

  const gen = deps.streamChat({
    baseUrl: deps.baseUrl ?? "",
    apiKey: deps.apiKey ?? "",
    model: deps.model ?? "",
    messages,
  });

  let reasoning = "";
  let content = "";
  let inReasoning = false;
  for await (const delta of gen) {
    if (delta.kind === "reasoning") {
      if (!inReasoning) {
        deps.write("\x1b[90m"); // 灰色起始(reasoning)
        inReasoning = true;
      }
      reasoning += delta.text;
      deps.write(delta.text);
    } else {
      if (inReasoning) {
        deps.write("\x1b[0m\n\n"); // 关灰色,正文换行起
        inReasoning = false;
      }
      content += delta.text;
      deps.write(delta.text);
    }
  }
  if (inReasoning) deps.write("\x1b[0m");
  deps.write("\n");
  return { reasoning, content };
}
