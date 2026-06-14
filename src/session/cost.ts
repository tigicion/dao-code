import type { UsageTotals } from "./session.js";

// P3-17 人民币计费:按 token 用量估算￥成本。前缀缓存命中的输入按更低的"命中价"计。
// 默认价为 DeepSeek 公开价量级(￥/百万 token),仅供估算;可用 env 覆盖以匹配实际模型/档位:
//   DAO_PRICE_INPUT_HIT(缓存命中输入)/ DAO_PRICE_INPUT_MISS(未命中输入)/ DAO_PRICE_OUTPUT(输出)
export interface Prices { inputHit: number; inputMiss: number; output: number } // ￥ / 1M tokens

const num = (env: string | undefined, def: number): number => {
  const n = Number(env);
  return Number.isFinite(n) && n >= 0 ? n : def;
};

export function loadPrices(env: NodeJS.ProcessEnv = process.env): Prices {
  return {
    inputHit: num(env.DAO_PRICE_INPUT_HIT, 0.5),
    inputMiss: num(env.DAO_PRICE_INPUT_MISS, 2),
    output: num(env.DAO_PRICE_OUTPUT, 8),
  };
}

// 估算本会话累计￥成本。注:dao 把主模型/flash/子代理的用量汇总在一起,这里按一套价估算,
// 是粗略值(flash 部分会被高估);用于成本感知与预算上限,不作账单。
export function estimateCostCNY(usage: UsageTotals, prices: Prices = loadPrices()): number {
  const hit = usage.cacheHitTokens;
  // 未命中输入 = 总输入 - 命中(防 cacheMiss 字段缺失时也对得上)。
  const miss = Math.max(0, usage.promptTokens - hit);
  return (hit * prices.inputHit + miss * prices.inputMiss + usage.completionTokens * prices.output) / 1_000_000;
}

export function formatCNY(yuan: number): string {
  if (yuan < 0.01) return `￥${yuan.toFixed(4)}`;
  return `￥${yuan.toFixed(yuan < 1 ? 3 : 2)}`;
}
