import type { Usage } from "../client/types.js";

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
