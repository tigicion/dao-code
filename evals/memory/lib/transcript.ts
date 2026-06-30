// 真实 session 的 events.jsonl(见 src/session/log.ts 的事件形状)→ reflect/distill 吃的 messages[]。
export type RawEvent =
  | { t: "user"; text: string }
  | { t: "assistant"; content: string | null; toolCalls?: { name: string; args: string }[] }
  | { t: "tool_result"; name: string; ok?: boolean; content: string }
  | { t: "turn_end" }
  | { t: "notice"; text: string };

const TOOL_RESULT_CAP = 800; // 单条工具结果截断,避免喂进去爆长

export function parseJsonl(raw: string): RawEvent[] {
  const out: RawEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as RawEvent); } catch { /* 坏行跳过 */ }
  }
  return out;
}

function toolCallSummary(calls?: { name: string; args: string }[]): string {
  if (!calls || !calls.length) return "";
  return "[调用工具] " + calls.map((c) => c.name).join(", ");
}

export function toMessages(events: RawEvent[], opts?: { toolResultCap?: number }): { role: string; content: string }[] {
  const cap = opts?.toolResultCap ?? TOOL_RESULT_CAP;
  const msgs: { role: string; content: string }[] = [];
  for (const e of events) {
    if (e.t === "user") msgs.push({ role: "user", content: e.text });
    else if (e.t === "assistant") {
      const body = e.content && e.content.trim() ? e.content : toolCallSummary(e.toolCalls);
      if (body) msgs.push({ role: "assistant", content: body });
    } else if (e.t === "tool_result") {
      const c = e.content.length > cap ? e.content.slice(0, cap) + "…(截断)" : e.content;
      msgs.push({ role: "user", content: `[工具 ${e.name} 结果] ${c}` });
    }
    // turn_end / notice:丢弃(notice 是反思注入痕迹,不该喂回模型)
  }
  return msgs;
}

export function windowMessages(msgs: { role: string; content: string }[], maxChars = 24000): { role: string; content: string }[] {
  const out: { role: string; content: string }[] = [];
  let total = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (total + m.content.length > maxChars) break;
    out.unshift(m);
    total += m.content.length;
  }
  return out;
}
