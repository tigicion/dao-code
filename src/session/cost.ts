import type { UsageTotals } from "./session.js";

// P3-17 / B-2 人民币计费:按 token 用量 + 模型分别估算￥成本。前缀缓存命中的输入按更低的"命中价"计。
// 参考价(￥/1M):Pro 命中 0.025 / 未命中 3 / 输出 6;Flash 命中 0.02 / 未命中 1 / 输出 2。
// 按【模型分桶】计价(主模型 pro 与 flash 子任务各自算),比单桶更准。env 可覆盖。
export interface Prices { inputHit: number; inputMiss: number; output: number } // ￥ / 1M tokens

const num = (env: string | undefined, def: number): number => {
  const n = Number(env);
  return Number.isFinite(n) && n >= 0 ? n : def;
};

// 按模型名取价:含 "flash" → Flash 价,否则 Pro 价。各自可被 env 覆盖。
export function pricesFor(model: string, env: NodeJS.ProcessEnv = process.env): Prices {
  if (/flash/i.test(model)) {
    return {
      inputHit: num(env.DAO_PRICE_FLASH_INPUT_HIT, 0.02),
      inputMiss: num(env.DAO_PRICE_FLASH_INPUT_MISS, 1),
      output: num(env.DAO_PRICE_FLASH_OUTPUT, 2),
    };
  }
  return {
    inputHit: num(env.DAO_PRICE_INPUT_HIT, 0.025),
    inputMiss: num(env.DAO_PRICE_INPUT_MISS, 3),
    output: num(env.DAO_PRICE_OUTPUT, 6),
  };
}

// 兼容旧签名:用一套价估算单桶用量(默认 Pro 价)。
export function loadPrices(env: NodeJS.ProcessEnv = process.env): Prices {
  return pricesFor("pro", env);
}

export function estimateCostCNY(usage: UsageTotals, prices: Prices = loadPrices()): number {
  const hit = usage.cacheHitTokens;
  const miss = Math.max(0, usage.promptTokens - hit); // 未命中 = 总输入 - 命中(容忍 miss 字段缺失)
  return (hit * prices.inputHit + miss * prices.inputMiss + usage.completionTokens * prices.output) / 1_000_000;
}

// B-2 按模型分桶求总成本:每个模型的用量用其对应价算,相加。
export function estimateCostByModel(buckets: Map<string, UsageTotals>, env: NodeJS.ProcessEnv = process.env): number {
  let total = 0;
  for (const [model, u] of buckets) total += estimateCostCNY(u, pricesFor(model, env));
  return total;
}

export function formatCNY(yuan: number): string {
  if (yuan < 0.01) return `￥${yuan.toFixed(4)}`;
  return `￥${yuan.toFixed(yuan < 1 ? 3 : 2)}`;
}
