export type MemoryScope = "project" | "user";
export type MemoryType = "user" | "semantic" | "procedural" | "episodic";

export interface Memory {
  name: string;              // slug = 文件名(不含 .md)
  text: string;              // 正文:一句话事实/规则
  type: MemoryType;
  importance: number;        // 1–10
  confidence?: number;       // 0–1,用户模型/推断类用
  created: string;           // ISO date
  lastUsed: string;
  source?: string;           // "path" 或 "path#symbol"(仅从代码推导的事实)
  sourceHash?: string;       // 写入时 source 内容的 hash
  uses: number;              // 重确认计数:每次去重命中 +1(衰减 GC 的强化信号)
  status: "active" | "superseded";
  supersededBy?: string;
  validUntil?: string;
  locked?: boolean;
}

export function newMemory(p: {
  name: string; text: string; type: MemoryType; today: string;
  importance?: number; confidence?: number; source?: string; sourceHash?: string;
}): Memory {
  return {
    name: p.name, text: p.text.trim(), type: p.type,
    importance: p.importance ?? 5,
    ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
    created: p.today, lastUsed: p.today,
    ...(p.source ? { source: p.source } : {}),
    ...(p.sourceHash ? { sourceHash: p.sourceHash } : {}),
    uses: 0,
    status: "active", locked: false,
  };
}
