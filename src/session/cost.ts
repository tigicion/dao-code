import type { UsageTotals } from "./session.js";

// P3-17 / B-2 人民币计费:按 token 用量 + 模型分别估算￥成本。前缀缓存命中的输入按更低的"命中价"计。
// 按【模型分桶】计价(主模型与 flash/子任务各自算),比单桶更准。
export interface Prices { inputHit: number; inputMiss: number; output: number } // ￥ / 1M tokens

const num = (env: string | undefined, def: number): number => {
  const n = Number(env);
  return Number.isFinite(n) && n >= 0 ? n : def;
};

// 各模型实价(￥/1M tokens),2026-09 按各厂商官方计费页核实:
// - deepseek-v4-pro/flash:DeepSeek 官方 peak 价 $1.32/$3.96、$0.30/$1.20,按汇率 6.8 折算。
// - claude-opus/sonnet:Anthropic 官方 $5/$25、$3/$15、$2/$10,按汇率 6.8 折算。
// - glm-5.2/5.3:智谱官方 ￥8/￥28;glm-5.3-flash:￥0.8/￥2.8。
// - gpt-5.5:OpenAI 官方 $5/$30,按汇率 6.8 折算。
// - doubao/kimi/minimax/ernie:火山方舟(ARK)/百度千帆/Moonshot/MiniMax 官方计费页。
// 网关模型名(如 DeepSeek-V4-Pro-joybuilder)通过 normalizeModelKey 归一化后匹配。
export const KNOWN_PRICES: Record<string, Prices> = {
  // DeepSeek(￥/1M,peak 价;cache hit = miss/10)
  "deepseek-v4-pro": { inputHit: 0.9, inputMiss: 9, output: 27 },
  "deepseek-v4-flash": { inputHit: 0.2, inputMiss: 2, output: 8.2 },
  // Claude($/1M → ￥按 6.8 折算;cache hit = miss/10)
  "claude-opus-4-6": { inputHit: 3.4, inputMiss: 34, output: 170 },
  "claude-opus-4-7": { inputHit: 3.4, inputMiss: 34, output: 170 },
  "claude-opus-4-8": { inputHit: 3.4, inputMiss: 34, output: 170 },
  "claude-sonnet-4-6": { inputHit: 2.04, inputMiss: 20.4, output: 102 },
  "claude-sonnet-5": { inputHit: 1.36, inputMiss: 13.6, output: 68 },
  // GLM(￥/1M;cache hit = miss/4)
  "glm-5-2": { inputHit: 2, inputMiss: 8, output: 28 },
  "glm-5-3": { inputHit: 2, inputMiss: 8, output: 28 },
  "glm-5-3-flash": { inputHit: 0.2, inputMiss: 0.8, output: 2.8 },
  // GPT($/1M → ￥按 6.8 折算;cache hit = miss/10)
  "gpt-5-5": { inputHit: 3.4, inputMiss: 34, output: 204 },
  // 其他国产模型(￥/1M)
  "doubao-seed-2-0-pro": { inputHit: 0.64, inputMiss: 3.2, output: 16 },
  "doubao-seed-2-0-lite": { inputHit: 0.12, inputMiss: 0.6, output: 3.6 },
  "doubao-seed-2-0-code": { inputHit: 0.64, inputMiss: 3.2, output: 16 },
  "glm-5-1": { inputHit: 1.3, inputMiss: 6, output: 24 },
  "kimi-k2.6": { inputHit: 1.1, inputMiss: 6.5, output: 27 },
  "kimi-k2.7-code": { inputHit: 1.3, inputMiss: 6.5, output: 27 },
  "minimax-m2.7": { inputHit: 0.42, inputMiss: 2.1, output: 8.4 },
  "minimax-m3": { inputHit: 0.42, inputMiss: 2.1, output: 8.4 },
  "ernie-5.1": { inputHit: 1.6, inputMiss: 4, output: 18 },
};

// 网关模型名归一化:小写 + 去 -joybuilder / -local 后缀 + 点转横杠,
// 使网关返回的模型名(如 Claude-Opus-4.8-joybuilder)能命中 KNOWN_PRICES 里的 key(如 claude-opus-4-8)。
function normalizeModelKey(model: string): string {
  return model.toLowerCase().replace(/-joybuilder$/, "").replace(/-local$/, "").replace(/\./g, "-");
}

// 按模型名取价:先精确匹配,再归一化匹配(网关模型名);命中不了退化到 pro/flash 启发式,避免报错。
// env 覆盖启发式挡与汇率。
export function pricesFor(model: string, env: NodeJS.ProcessEnv = process.env): Prices {
  const known = KNOWN_PRICES[model];
  if (known) return known;
  const norm = normalizeModelKey(model);
  const knownNorm = KNOWN_PRICES[norm];
  if (knownNorm) return knownNorm;
  if (/flash/i.test(model)) {
    return {
      inputHit: num(env.DAO_PRICE_FLASH_INPUT_HIT, 0.2),
      inputMiss: num(env.DAO_PRICE_FLASH_INPUT_MISS, 2),
      output: num(env.DAO_PRICE_FLASH_OUTPUT, 8.2),
    };
  }
  return {
    inputHit: num(env.DAO_PRICE_INPUT_HIT, 0.9),
    inputMiss: num(env.DAO_PRICE_INPUT_MISS, 9),
    output: num(env.DAO_PRICE_OUTPUT, 27),
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
