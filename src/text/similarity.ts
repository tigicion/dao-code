// 文本相似度的确定性原语——字符二元组(bigram shingle)。
// 关键:对中文(CJK 无词边界)鲁棒。按空白/标点分词会把整句中文塌缩成一个匹配不上的大块,
// 而相邻字符二元组天然跨过词边界,中英文一视同仁。记忆去重与技能发现共用此实现。

// 去掉标点/空白后取相邻字符二元组;单字符串退化为该字符本身。
export function shingles(s: string): Set<string> {
  const chars = [...s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")];
  const out = new Set<string>();
  if (chars.length <= 1) { if (chars.length === 1) out.add(chars[0] ?? ""); return out; }
  for (let i = 0; i < chars.length - 1; i++) out.add((chars[i] ?? "") + (chars[i + 1] ?? ""));
  return out;
}

// Jaccard:交 / 并。两边都空视为相同(1)。
export function textSimilarity(a: string, b: string): number {
  const A = shingles(a), B = shingles(b); if (!A.size && !B.size) return 1;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// 两组 shingle 的交集大小(原始重叠计数)。用于召回排序——只比"共享了多少",不被长度归一压低长文本。
export function shingleOverlap(a: Set<string>, b: Set<string>): number {
  let inter = 0; for (const t of a) if (b.has(t)) inter++;
  return inter;
}
