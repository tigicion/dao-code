import type { ChatMessage } from "../client/types.js";

const trunc = (s: string, n = 300): string => (s.length > n ? s.slice(0, n) + "…" : s);

// 为 auto 模式分类器构建紧凑 transcript(参考 buildTranscriptEntries):
// 只取【用户文本】与【助手的工具调用】,故意排除助手自由文本——防止模型用解释性文字反向操纵分类器。
// 输出紧凑 JSONL:{"user":"修下登录"}\n{"Bash":"{\"command\":\"npm test\"}"} …
export function buildClassifierTranscript(messages: ChatMessage[], maxEntries = 12): string {
  const entries: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : m.content.filter(p => p.type === "text").map(p => p.text).join(" ");
      if (text.trim()) entries.push(JSON.stringify({ user: trunc(text.trim()) }));
    } else if (m.role === "assistant" && m.tool_calls?.length) {
      for (const tc of m.tool_calls) entries.push(JSON.stringify({ [tc.function.name]: trunc(tc.function.arguments) }));
    }
  }
  return entries.slice(-maxEntries).join("\n");
}

const SYS =
  "You are the auto-mode safety classifier for an AI coding agent. Judge whether the agent's tool call is safe to auto-approve." +
  " Context: recent conversation (user messages + tool calls only) is provided." +
  " ALLOW: operations consistent with user intent, reversible, no credentials/secrets, no data destruction, no external exfiltration, stays in workspace." +
  " DENY: irreversible destruction (rm -rf, drop table, force push), install/network download+execute, reading/writing credentials (.ssh/.aws/.env), " +
  "unrelated or out-of-scope operations. When unsure, DENY (fail-closed). Reply with exactly one word: allow or deny.";

// 组装分类器的 messages:系统指令 + (近期 transcript + 本次待判调用)作为 user。
export function buildClassifierMessages(
  toolName: string,
  argsJson: string,
  recentMessages: ChatMessage[],
): { role: "system" | "user"; content: string }[] {
  const transcript = buildClassifierTranscript(recentMessages);
  const ctx = transcript ? `近期对话:\n${transcript}\n\n` : "";
  return [
    { role: "system", content: SYS },
    { role: "user", content: `${ctx}Tool call to judge:\n${JSON.stringify({ [toolName]: trunc(argsJson) })}\n\nallow or deny?` },
  ];
}
