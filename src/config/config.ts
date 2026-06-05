export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("Missing DEEPSEEK_API_KEY (set it in your environment).");
  }
  return {
    apiKey,
    baseUrl: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    model: env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
  };
}
