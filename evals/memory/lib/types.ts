// 记忆效果评测的共享类型。MemoryType 从 src 复用以对齐 scope 路由。
import type { MemoryType } from "../../../src/memory/types.js";

export interface GoldFact { text: string; type: MemoryType; scope: "project" | "user" | "knowledge"; profile?: boolean; }
export interface ExtractGold { existing: { title: string; text: string }[]; mustExtract: GoldFact[]; mustNot: string[]; }
export interface RecallContext { task: string; valueGold: string[]; relevanceGold: string[]; }
export interface JudgeResult { scores: Record<string, number>; verdicts: Record<string, unknown>; rationale: string; }
export interface EvalConfig { model: string; baseUrl: string; apiKey: string; judgeK: number; }

export function isGoldFact(x: unknown): x is GoldFact {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.text === "string" && typeof o.type === "string" && typeof o.scope === "string";
}
