// 召回轴 A/B:push(现状,src/memory/inject.ts 的两层读取)vs pull(CC 风格,仅索引、模型自己决定读哪条)。
// allLiveTitles 是 pull 轴的"注入集"——不像 selectFullText 那样给 user/feedback/locked 全文特权,
// 一律只留标题,逼近 CC「只有 MEMORY.md 索引常驻,模型主动 Read 单条」的设计。
import type { Memory } from "../../src/memory/types.js";
import type { Verdict } from "../../src/memory/validate.js";

export function allLiveTitles(items: { mem: Memory; verdict: Verdict }[]): string[] {
  return items.filter((x) => x.verdict !== "stale").map((x) => x.mem.title || x.mem.name);
}
