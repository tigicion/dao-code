import type { Usage } from "../client/types.js";

// Laminar 保留的 tags 键:值为字符串数组,后端/UI 有专门的 tag 过滤面(区别于普通 association 属性)。
export const TAGS_KEY = "lmnr.association.properties.tags";

// LaminarAttributes 键(与 @lmnr-ai/lmnr 的 gen_ai/llm 语义约定一致)。
const REQUEST_MODEL = "gen_ai.request.model";
const INPUT_TOKENS = "gen_ai.usage.input_tokens";
const OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
const TOTAL_TOKENS = "llm.usage.total_tokens";

/** 把一次 LLM 调用的 model + usage 翻成 Laminar LLM span 属性对象。 */
export function llmAttributes(model: string, usage?: Usage): Record<string, number | string> {
  const attrs: Record<string, number | string> = { [REQUEST_MODEL]: model };
  if (usage) {
    attrs[INPUT_TOKENS] = usage.prompt_tokens;
    attrs[OUTPUT_TOKENS] = usage.completion_tokens;
    attrs[TOTAL_TOKENS] = usage.total_tokens;
  }
  return attrs;
}

/** DeepSeek 扁平 cache 字段 → span tag;无信息则 undefined。 */
export function cacheTag(usage?: Usage): "cache_hit" | "cache_miss" | undefined {
  if (!usage) return undefined;
  if ((usage.prompt_cache_hit_tokens ?? 0) > 0) return "cache_hit";
  if ((usage.prompt_cache_miss_tokens ?? 0) > 0) return "cache_miss";
  return undefined;
}

// cache_low 异常判定的默认阈值(可用 DAO_OBS_CACHE_LOW_FLOOR / _RATE 覆盖)。
// 语义:上下文已足够大(理应命中热缓存)却命中率偏低 → 疑似服务端缓存驱逐(呼应缓存非确定性课题)。
// 小提示词的冷启动天然低命中,用 floor 排除,避免噪声。
const CACHE_LOW_FLOOR = 10_000; // prompt_tokens 下限:低于此视为冷/小调用,不算异常
const CACHE_LOW_RATE = 0.5; // 命中率阈值

/** 已建立上下文却命中率异常低 → 返回 {hit_rate, prompt_tokens};否则 null。 */
export function cacheLow(
  usage?: Usage,
  floor = Number(process.env.DAO_OBS_CACHE_LOW_FLOOR) || CACHE_LOW_FLOOR,
  rate = Number(process.env.DAO_OBS_CACHE_LOW_RATE) || CACHE_LOW_RATE,
): { hit_rate: number; prompt_tokens: number } | null {
  if (!usage) return null;
  const prompt = usage.prompt_tokens;
  if (!prompt || prompt < floor) return null; // 冷/小调用:命中低是正常,不报
  const hit = usage.prompt_cache_hit_tokens ?? 0;
  const hitRate = hit / prompt;
  if (hitRate >= rate) return null;
  return { hit_rate: Math.round(hitRate * 1000) / 1000, prompt_tokens: prompt };
}
