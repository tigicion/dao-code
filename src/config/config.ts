// 读取配置,apiKey 可缺(由调用方解析:环境变量 > .env > 已存配置 > 交互输入)。
// 不再因缺 key 直接抛错——onboarding 由 index 负责引导。
export interface RawConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
}

export function readConfig(env: Record<string, string | undefined>): RawConfig {
  return {
    apiKey: env.DEEPSEEK_API_KEY || undefined,
    baseUrl: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    model: env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
  };
}
