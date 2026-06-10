import type { Memory } from "./types.js";
import type { Verdict } from "./validate.js";
import { daysBetween } from "./gc.js";

// 把通过验证的记忆拼成系统 prompt 的 {memory} 段:
// - stale 剔除(不注入);
// - changed 在正文后加"(可能已过期…)"提示;
// - ok 原样注入。
export function buildMemorySection(items: { mem: Memory; verdict: Verdict }[]): string {
  const lines: string[] = [];
  for (const { mem, verdict } of items) {
    if (verdict === "stale") continue;
    const suffix = verdict === "changed" ? "(可能已过期:来源已变,请以实时文件为准)" : "";
    lines.push(`- ${mem.text}${suffix}`);
  }
  return lines.join("\n");
}

// 注入封顶:store 过大时只选 top-K。会话启动无 query,故纯确定性、不用 embedding。
// - 先剔除 stale(既不计数也不注入);
// - 剩余 ≤ cap → 原样返回(保序);
// - 否则:user 模型与 feedback 全留;其余按 score = importance * 0.995^age 降序取剩余名额。
export function selectForInjection(
  items: { mem: Memory; verdict: Verdict }[],
  today: string,
  cap = 150,
): { mem: Memory; verdict: Verdict }[] {
  const live = items.filter((x) => x.verdict !== "stale");
  if (live.length <= cap) return live;
  const keep = (t: Memory["type"]) => t === "user" || t === "feedback";
  const userFacts = live.filter((x) => keep(x.mem.type));
  const rest = live.filter((x) => !keep(x.mem.type));
  const take = Math.max(0, cap - userFacts.length);
  const score = (m: Memory): number => m.importance * Math.pow(0.995, daysBetween(m.lastUsed, today));
  const topRest = [...rest].sort((a, b) => score(b.mem) - score(a.mem)).slice(0, take);
  return [...userFacts, ...topRest];
}
