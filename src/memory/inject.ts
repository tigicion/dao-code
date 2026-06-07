import type { Memory } from "./types.js";
import type { Verdict } from "./validate.js";

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
