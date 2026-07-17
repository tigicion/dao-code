import type { UsageTotals } from "./session.js";

// P3-17 / B-2 人民币计费:按 token 用量 + 模型分别估算￥成本。前缀缓存命中的输入按更低的"命中价"计。
// 按【模型分桶】计价(主模型与 flash/子任务各自算),比单桶更准。
export interface Prices { inputHit: number; inputMiss: number; output: number } // ￥ / 1M tokens

const num = (env: string | undefined, def: number): number => {
  const n = Number(env);
  return Number.isFinite(n) && n >= 0 ? n : def;
};

// 各模型实价(￥/1M tokens),2026-07 按各厂商官方计费页核实:
// - deepseek-v4-pro/flash:DAO 直连 DeepSeek 官方报价。
// - doubao/glm/kimi/minimax/ernie:火山方舟(ARK)/百度千帆/智谱/Moonshot/MiniMax 官方计费页(元/千tokens 换算为元/百万)。
export const KNOWN_PRICES: Record<string, Prices> = {
  "deepseek-v4-pro": { inputHit: 0.025, inputMiss: 3, output: 6 },
  "deepseek-v4-flash": { inputHit: 0.02, inputMiss: 1, output: 2 },
  "doubao-seed-2.0-pro": { inputHit: 0.64, inputMiss: 3.2, output: 16 },
  "doubao-seed-2.0-lite": { inputHit: 0.12, inputMiss: 0.6, output: 3.6 },
  "doubao-seed-2.0-code": { inputHit: 0.64, inputMiss: 3.2, output: 16 },
  "glm-5.2": { inputHit: 2, inputMiss: 8, output: 28 },
  "glm-5.1": { inputHit: 1.3, inputMiss: 6, output: 24 },
  "kimi-k2.6": { inputHit: 1.1, inputMiss: 6.5, output: 27 },
  "kimi-k2.7-code": { inputHit: 1.3, inputMiss: 6.5, output: 27 },
  "minimax-m2.7": { inputHit: 0.42, inputMiss: 2.1, output: 8.4 },
  "minimax-m3": { inputHit: 0.42, inputMiss: 2.1, output: 8.4 },
  "ernie-5.1": { inputHit: 1.6, inputMiss: 4, output: 18 },
};

// 美元报价(官方计费页,$/1M tokens)。换算汇率默认 6.8(2026-07 USD/CNY 中间价附近),可用 DAO_USD_CNY_RATE 覆盖。
const USD_PRICES: Record<string, Prices> = {
  "claude-opus-4-8": { inputHit: 0.5, inputMiss: 5, output: 25 },
  "gpt-5": { inputHit: 0.125, inputMiss: 1.25, output: 10 },
};

// 按模型名取价:已知模型走实价表;美元计价模型按汇率折算;其余未知模型(如自定义/新增串)
// 退化到旧的 pro/flash 启发式(含 "flash" → Flash 挡),避免报错。env 仅覆盖启发式挡与汇率。
export function pricesFor(model: string, env: NodeJS.ProcessEnv = process.env): Prices {
  const known = KNOWN_PRICES[model];
  if (known) return known;
  const usd = USD_PRICES[model];
  if (usd) {
    const rate = num(env.DAO_USD_CNY_RATE, 6.8);
    return { inputHit: usd.inputHit * rate, inputMiss: usd.inputMiss * rate, output: usd.output * rate };
  }
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
