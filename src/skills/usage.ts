import { promises as fs } from "node:fs";
import path from "node:path";

// 技能使用频率加权(对标 CC skillUsageTracking):记每个技能被加载的次数 + 最近日期,
// 按"指数衰减 × 次数"打分,用于发现排序的并列打破与常驻列表的预算截断排序。
// 常被用且最近用过的技能排在前。纯确定性(日期注入),持久化到 ~/.dao/skill-usage.json。

export interface UsageEntry { count: number; lastUsedAt: string } // lastUsedAt:ISO YYYY-MM-DD
export type UsageMap = Record<string, UsageEntry>;

const HALF_LIFE_DAYS = 7; // 7 天半衰期,与 CC 一致
const MIN_RECENCY = 0.1; // 衰减系数下限:再久没用过的"老熟人"也保留一点权重

function daysBetween(a: string, b: string): number {
  const da = Date.parse(a + "T00:00:00Z"), db = Date.parse(b + "T00:00:00Z");
  if (Number.isNaN(da) || Number.isNaN(db)) return 0;
  return Math.abs(db - da) / 86_400_000;
}

// 不可变更新:返回累加后的新 map(便于测试与持久化时机解耦)。
export function recordUsage(m: UsageMap, name: string, today: string): UsageMap {
  const prev = m[name];
  return { ...m, [name]: { count: (prev?.count ?? 0) + 1, lastUsedAt: today } };
}

// 得分 = 次数 × max(0.5^(天数/半衰期), 0.1);无记录为 0。
export function usageScore(m: UsageMap, name: string, today: string): number {
  const e = m[name];
  if (!e) return 0;
  const recency = Math.max(Math.pow(0.5, daysBetween(e.lastUsedAt, today) / HALF_LIFE_DAYS), MIN_RECENCY);
  return e.count * recency;
}

function usagePath(homeDir: string): string {
  return path.join(homeDir, ".dao", "skill-usage.json");
}

export async function loadUsage(homeDir: string): Promise<UsageMap> {
  try {
    return JSON.parse(await fs.readFile(usagePath(homeDir), "utf8")) as UsageMap;
  } catch {
    return {};
  }
}

export async function saveUsage(homeDir: string, m: UsageMap): Promise<void> {
  const p = usagePath(homeDir);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(m, null, 2), "utf8").catch(() => {});
}
