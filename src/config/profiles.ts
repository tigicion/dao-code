// 凭证档案(profile)数据模型:一个 profile = { provider + 凭证 + baseUrl + 默认 model }。
// 多 key 切换 = 切 profile;多 provider = profile 带不同 provider;未来订阅 = 另一种凭证类型。
// 不引入"用户(user)"概念——DAO 是本地 CLI,DeepSeek 无账号体系,user 等于给不存在的登录服务器建模。

export type Provider = "deepseek" | "anthropic" | "openai" | "volcengine";

export interface Profile {
  provider: Provider;
  baseUrl: string;
  model: string;
  key?: string; // 明文落盘时内联;存进钥匙串时改用 keyRef
  keyRef?: string; // 如 "keychain:dao/work"
}

export interface ProfilesConfig {
  version: 2;
  onboardingComplete?: boolean;
  activeProfile: string;
  profiles: Record<string, Profile>;
}

export const DEFAULTS: Record<Provider, { baseUrl: string; model: string }> = {
  deepseek: { baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" },
  volcengine: { baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", model: "deepseek-v4-pro" },
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-opus-4-8" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-5" },
};

function isV2(raw: unknown): raw is ProfilesConfig {
  return !!raw && typeof raw === "object" && (raw as { version?: unknown }).version === 2;
}

// 旧版 { apiKey, baseUrl?, model? } 或 v2 → 规范化的 v2(内存形态)。null/损坏 → 全新空档案。
export function migrateConfig(raw: unknown): ProfilesConfig {
  if (isV2(raw)) return raw;
  const legacy = (raw && typeof raw === "object" ? raw : {}) as {
    apiKey?: unknown;
    baseUrl?: unknown;
    model?: unknown;
  };
  if (typeof legacy.apiKey === "string" && legacy.apiKey) {
    return {
      version: 2,
      activeProfile: "default",
      profiles: {
        default: {
          provider: "deepseek",
          baseUrl: typeof legacy.baseUrl === "string" ? legacy.baseUrl : DEFAULTS.deepseek.baseUrl,
          model: typeof legacy.model === "string" ? legacy.model : DEFAULTS.deepseek.model,
          key: legacy.apiKey,
        },
      },
    };
  }
  return { version: 2, activeProfile: "default", profiles: {} };
}

export interface ResolvedCredential {
  key: string;
  provider: Provider;
  baseUrl: string;
  model: string;
  source: string; // "env:DEEPSEEK_API_KEY" | "env:ARK_API_KEY" | "profile:<name>"
}

// 解析当前生效凭证:只看激活 profile 的 key(文件内联或钥匙串)。
// 不读环境变量——交互模式只有 profile 一条路径;headless 通过 --api-key CLI 参数传入。
// 没有 key → null(需要 onboarding 或 headless 传参)。
export function resolveActive(cfg: ProfilesConfig): ResolvedCredential | null {
  const p = cfg.profiles[cfg.activeProfile];
  if (p && p.key) {
    return {
      key: p.key,
      provider: p.provider,
      baseUrl: p.baseUrl,
      model: p.model,
      source: `profile:${cfg.activeProfile}`,
    };
  }
  return null;
}
