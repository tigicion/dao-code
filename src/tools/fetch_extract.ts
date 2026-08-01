import type { Provider } from "../config/profiles.js";

// WebFetch 智能提取(prompt 参数)调用哪个模型。DeepSeek 系(deepseek/volcengine/qianfan)三个
// provider 都能打 deepseek-v4-flash;anthropic/openai 当前未配置便宜档,回退用主模型(同 SUMMARY_MODEL
// 的既有降级方式,src/index.ts:1280)。
export function resolveExtractModel(envOverride: string | undefined, provider: Provider, sessionModel: string): string {
  if (envOverride) return envOverride;
  if (provider === "deepseek" || provider === "volcengine" || provider === "qianfan") return "deepseek-v4-flash";
  return sessionModel;
}
