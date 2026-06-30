// 评测纯指标:P/R/F1、聚合(中位/方差)、多数票、相关性缺口。无 I/O。
export function precisionRecall(predicted: Set<string>, gold: Set<string>): { p: number; r: number; f1: number } {
  let tp = 0;
  for (const x of predicted) if (gold.has(x)) tp++;
  const p = predicted.size ? tp / predicted.size : 0;
  const r = gold.size ? tp / gold.size : 0;
  const f1 = p + r ? (2 * p * r) / (p + r) : 0;
  return { p, r, f1 };
}

export function aggregate(xs: number[]): { median: number; mean: number; stdev: number; min: number; max: number } {
  if (!xs.length) return { median: 0, mean: 0, stdev: 0, min: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  const stdev = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { median, mean, stdev, min: s[0]!, max: s[s.length - 1]! };
}

export function majorityVote(bs: boolean[]): { value: boolean; agreement: number } {
  // 空投票 → value:false(防 K=0/NaN 时 votes=[] 被当作恒 true 的静默假满分)
  const t = bs.filter(Boolean).length;
  return { value: bs.length > 0 && t * 2 >= bs.length, agreement: bs.length ? Math.max(t, bs.length - t) / bs.length : 0 };
}

export function relevanceGap(injected: Set<string>, relevanceGold: Set<string>): number {
  if (!relevanceGold.size) return 0;
  let missed = 0;
  for (const x of relevanceGold) if (!injected.has(x)) missed++;
  return missed / relevanceGold.size;
}
