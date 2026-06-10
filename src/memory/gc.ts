import { promises as fs } from "node:fs";
import path from "node:path";
import type { Memory } from "./types.js";
import { parseMemoryFile } from "./frontmatter.js";

const DAY_MS = 86_400_000;

// 两个 YYYY-MM-DD 间的非负整天差;解析失败返回 0。
export function daysBetween(a: string, b: string): number {
  const ta = Date.parse(a), tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
  return Math.round(Math.abs(tb - ta) / DAY_MS);
}

// Ebbinghaus 留存曲线:稳定度 S 随重确认次数 uses 线性增长。
// 标定:S = 45*(1+uses),uses=0 时 exp(-54/45)=0.30 → 一次见过的低重要度事实约 54 天后跌破阈值。
export function retention(mem: Memory, today: string): number {
  const S = 45 * (1 + (mem.uses ?? 0));
  return Math.exp(-daysBetween(mem.lastUsed, today) / S);
}

// 加 N 天到 YYYY-MM-DD,返回 YYYY-MM-DD;解析失败返回原串。
function addDays(date: string, n: number): string {
  const t = Date.parse(date);
  if (Number.isNaN(t)) return date;
  return new Date(t + n * DAY_MS).toISOString().slice(0, 10);
}

// 是否应剪除。保护:user 模型 / feedback(用户给的工作方式指导,丢了会重蹈覆辙)/ importance≥6 / locked / 频繁重确认(高 uses 抬高留存)。
export function shouldPrune(mem: Memory, today: string): boolean {
  // (a) 已被取代且 validUntil + 7 天宽限期已过。
  if (mem.status === "superseded" && mem.validUntil && addDays(mem.validUntil, 7) < today) return true;
  // (b) 留存跌破阈值且非保护类。
  if (
    retention(mem, today) < 0.3 &&
    mem.importance < 6 &&
    mem.type !== "user" &&
    mem.type !== "feedback" &&
    mem.locked !== true
  ) return true;
  return false;
}

// 扫描目录下所有 *.md,删除应剪除的文件,返回被剪名字。目录不存在 → []。确定性,无 LLM。
export async function gcMemories(dir: string, today: string): Promise<string[]> {
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return []; }
  const pruned: string[] = [];
  for (const f of names) {
    if (!f.endsWith(".md")) continue;
    const raw = await fs.readFile(path.join(dir, f), "utf8").catch(() => "");
    const m = parseMemoryFile(f.slice(0, -3), raw);
    if (!m) continue;
    if (shouldPrune(m, today)) {
      await fs.rm(path.join(dir, f), { force: true }).catch(() => {});
      pruned.push(m.name);
    }
  }
  return pruned;
}
