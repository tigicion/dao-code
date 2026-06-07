import type { AssistantMessage, StreamDelta, ToolCall, ToolMessage } from "../client/types.js";
import { renderMarkdown } from "./markdown.js";

// 回合渲染事件:把"一轮流式 + 工具"拆成结构化事件,与具体渲染解耦。
// 两个适配器:plainEvents(复刻终端 ANSI 输出,供非 TTY/eval/子代理)、Ink 适配器(喂 React state)。
export interface TurnEvents {
  reasoning(chunk: string): void;
  content(chunk: string): void;
  assistantDone(msg: AssistantMessage): void;
  toolStart(call: { index: number; name: string }): void;
  toolResult(call: ToolCall, msg: ToolMessage): void;
  notice(text: string): void;
}

// 消费一轮流式增量,发事件;返回拼好的 assistant 消息。
export async function consumeStream(
  gen: AsyncGenerator<StreamDelta, AssistantMessage>,
  events: TurnEvents,
): Promise<AssistantMessage> {
  let r = await gen.next();
  while (!r.done) {
    const d = r.value;
    if (d.kind === "reasoning") events.reasoning(d.text);
    else if (d.kind === "content") events.content(d.text);
    else events.toolStart({ index: d.index, name: d.name });
    r = await gen.next();
  }
  events.assistantDone(r.value);
  return r.value;
}

// 纯文本(ANSI)适配器:reasoning 实时灰显;content 缓冲到边界再整体 markdown;tool_call 青色标记。
// 行为与旧 renderStream 完全一致(eval/子代理依赖此输出)。
export function plainEvents(write: (s: string) => void): TurnEvents {
  let inReasoning = false;
  let contentBuf = "";
  const flush = () => {
    if (contentBuf) {
      write(renderMarkdown(contentBuf));
      contentBuf = "";
    }
  };
  return {
    reasoning(chunk) {
      if (!inReasoning) {
        write("\x1b[90m");
        inReasoning = true;
      }
      write(chunk);
    },
    content(chunk) {
      if (inReasoning) {
        write("\x1b[0m\n\n");
        inReasoning = false;
      }
      contentBuf += chunk;
    },
    toolStart(call) {
      if (inReasoning) {
        write("\x1b[0m\n");
        inReasoning = false;
      }
      flush();
      write(`\x1b[36m→ ${call.name}\x1b[0m\n`);
    },
    assistantDone() {
      if (inReasoning) {
        write("\x1b[0m");
        inReasoning = false;
      }
      flush();
      write("\n");
    },
    toolResult() {
      // 纯文本模式当前不展示工具结果(与旧行为一致)。
    },
    notice(text) {
      write(text);
    },
  };
}

// 向后兼容封装:旧签名 renderStream(gen, write)。
export function renderStream(
  gen: AsyncGenerator<StreamDelta, AssistantMessage>,
  write: (s: string) => void,
): Promise<AssistantMessage> {
  return consumeStream(gen, plainEvents(write));
}
