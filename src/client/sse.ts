export interface SSEParseResult {
  payloads: string[];
  rest: string;
}

// SSE 事件以空行(\n\n)分隔。把已完整的事件解析出来,残留留给下一块。
export function parseSSEChunk(buffer: string): SSEParseResult {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? ""; // 最后一段可能不完整
  const payloads: string[] = [];
  for (const event of parts) {
    for (const line of event.split("\n")) {
      if (line.startsWith("data:")) {
        payloads.push(line.slice("data:".length).trim());
      }
    }
  }
  return { payloads, rest };
}
