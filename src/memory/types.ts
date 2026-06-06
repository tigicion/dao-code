export type MemoryScope = "project" | "user";

// P1 只存事实文本;P2/P3 可扩展 id/createdAt/importance/embedding 等字段。
export interface Memory {
  text: string;
}
