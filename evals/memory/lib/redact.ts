// 进仓 fixture 脱敏:抠密钥 + 归一 home 路径 + 按映射替换敏感专名。保留耐久事实语义。
// 离线产 fixture 时跑一次,不在评测热路径。
import { redactSecrets } from "../../../src/permissions/secrets.js";
import type { RawEvent } from "./transcript.js";

export function redactText(s: string, rules?: { homedir?: string; nameMap?: Record<string, string> }): string {
  let out = s;
  // 1) 密钥:抠密钥(redactSecrets 按命中类型替换为 [已隐去:类型])
  out = redactSecrets(out);
  // 2) home 路径归一
  if (rules?.homedir) out = out.split(rules.homedir).join("~");
  // 3) 专名映射(长 key 先替,避免子串冲突)
  for (const [from, to] of Object.entries(rules?.nameMap ?? {}).sort((a, b) => b[0].length - a[0].length)) {
    out = out.split(from).join(to);
  }
  return out;
}

export function redactEvents(events: RawEvent[], rules?: { homedir?: string; nameMap?: Record<string, string> }): RawEvent[] {
  return events.map((e) => {
    if (e.t === "user") return { ...e, text: redactText(e.text, rules) };
    if (e.t === "assistant") return {
      ...e,
      content: e.content ? redactText(e.content, rules) : e.content,
      // toolCalls.args 也要脱敏:toMessages 虽只取工具名,但 fixture 文件本身会落进仓库,args 里常含绝对路径/专名
      ...(e.toolCalls ? { toolCalls: e.toolCalls.map((tc) => ({ ...tc, args: redactText(tc.args, rules) })) } : {}),
    };
    if (e.t === "tool_result") return { ...e, content: redactText(e.content, rules) };
    return e;
  });
}
