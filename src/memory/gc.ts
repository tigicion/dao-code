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

// 低价值 user 推断:模型自己猜的(confidence<0.5)、从没被召回过(uses=0)、又不重要(importance<6)。
// 这类不享受 user 的永久保护——否则一次误猜会永远赖着(实测 rebrand 噪音正是如此);仍走留存曲线,
// 陈旧(~54 天没再被确认)后才剪,不会误删刚写下的新推断。
function lowValueUserInference(mem: Memory): boolean {
  return mem.type === "user" && (mem.confidence ?? 1) < 0.5 && (mem.uses ?? 0) === 0 && mem.importance < 6;
}

// provisional 耐久门宽限期(天):没被重确认(uses=0)的新记忆,过此期仍没复现就快剪。可调。
export const PROVISIONAL_WINDOW_DAYS = Number(process.env.DAO_PROVISIONAL_DAYS) || 7;

// provisional = 从未被重确认(uses=0)。confirmed = uses≥1(被去重合并过 = 再次出现过)。
// 写入层高频蒸馏下:反复出现的真知识很快 uses≥1 转 confirmed;中途一次性状态(后来被推翻的方案)
// 留在 uses=0,过宽限期被本门快剪——不必等 Ebbinghaus 的 ~54 天。
function isUnconfirmedProvisional(mem: Memory, today: string): boolean {
  return (
    (mem.uses ?? 0) === 0 &&
    daysBetween(mem.created, today) > PROVISIONAL_WINDOW_DAYS &&
    mem.importance < 6 && // 高重要(≥6)即便一次也留
    (mem.confidence ?? 1) < 0.8 // 高信心(≥0.8)即便一次也留
  );
}

// 是否应剪除。保护:确证的 user 模型 / feedback(用户给的工作方式指导,丢了会重蹈覆辙)/ importance≥6 / locked / 频繁重确认(高 uses 抬高留存)。
export function shouldPrune(mem: Memory, today: string): boolean {
  // (a) 已被取代且 validUntil + 7 天宽限期已过。
  if (mem.status === "superseded" && mem.validUntil && addDays(mem.validUntil, 7) < today) return true;
  const protectedType = (mem.type === "user" && !lowValueUserInference(mem)) || mem.type === "feedback";
  // (b) 留存跌破阈值且非保护类。user/feedback 受保护——但低价值 user 推断除外。
  if (
    retention(mem, today) < 0.3 &&
    mem.importance < 6 &&
    !protectedType &&
    mem.locked !== true
  ) return true;
  // (c) provisional 耐久门:未重确认的低信心/低重要新记忆,过宽限期快剪(治中途一次性状态)。
  //     user/feedback/locked 不受此门影响。
  if (isUnconfirmedProvisional(mem, today) && !protectedType && mem.locked !== true) return true;
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
