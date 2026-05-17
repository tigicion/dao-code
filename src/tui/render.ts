import type { AssistantMessage, StreamDelta } from "../client/types.js";
import { renderMarkdown } from "./markdown.js";

// 驱动一轮流式:reasoning 实时灰显;content 缓冲到边界再整体 markdown 渲染;
// tool_call 青色标记。返回 generator 的返回值(拼好的 assistant 消息)。
export async function renderStream(
  gen: AsyncGenerator<StreamDelta, AssistantMessage>,
  write: (s: string) => void,
): Promise<AssistantMessage> {
  let inReasoning = false;
  let contentBuf = "";
  const flush = () => {
    if (contentBuf) {
      write(renderMarkdown(contentBuf));
      contentBuf = "";
    }
  };

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
      contentBuf += d.text;
    } else {
      if (inReasoning) {
        write("\x1b[0m\n");
        inReasoning = false;
      }
      flush();
      write(`\x1b[36m→ ${d.name}\x1b[0m\n`);
    }
    r = await gen.next();
  }
  if (inReasoning) write("\x1b[0m");
  flush();
  write("\n");
  return r.value;
}
