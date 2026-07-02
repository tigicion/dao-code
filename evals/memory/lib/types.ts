// 记忆效果评测的共享类型。MemoryType 从 src 复用以对齐 scope 路由。
import type { MemoryType } from "../../../src/memory/types.js";

export interface GoldFact { text: string; type: MemoryType; scope: "project" | "user" | "knowledge"; profile?: boolean; }
export interface ExtractGold { existing: { title: string; text: string }[]; mustExtract: GoldFact[]; mustNot: string[]; }
// projectId:设了就对 knowledge 层记忆做【按项目过滤】(镜像 index.ts 的 keepKnowledgeForProject),
// 用来把"别项目学到的领域知识泄进本会话"这类 bug 钉成回归。不设 = 不过滤(旧 fixture 行为不变)。
export interface RecallContext { task: string; valueGold: string[]; relevanceGold: string[]; projectId?: string; }
export interface JudgeResult { scores: Record<string, number>; verdicts: Record<string, unknown>; rationale: string; }
export interface EvalConfig { model: string; baseUrl: string; apiKey: string; judgeK: number; }

export function isGoldFact(x: unknown): x is GoldFact {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.text === "string" && typeof o.type === "string" && typeof o.scope === "string";
}
