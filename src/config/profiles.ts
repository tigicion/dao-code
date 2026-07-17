// 凭证档案(profile)数据模型:一个 profile = { provider + 凭证 + baseUrl + 默认 model }。
// 多 key 切换 = 切 profile;多 provider = profile 带不同 provider;未来订阅 = 另一种凭证类型。
// 不引入"用户(user)"概念——DAO 是本地 CLI,DeepSeek 无账号体系,user 等于给不存在的登录服务器建模。

export type Provider = "deepseek" | "anthropic" | "openai" | "volcengine" | "qianfan";

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
  qianfan: { baseUrl: "https://qianfan.baidubce.com/v2/tokenplan/personal", model: "deepseek-v4-pro" },
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-opus-4-8" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-5" },
};

// 每个 provider 已知可用的模型串(/model 命令用来做校验+循环);deepseek 只有 pro/flash 两档,
// volcengine coding plan 额外支持 doubao/glm/kimi/minimax 系列——控制台列出但实测 coding plan
// 接口返回 UnsupportedModel 的串(如 doubao-seed-code,无 2.0 后缀的旧版)不收录,
// 每条都用真实 key 打过 /chat/completions 拿到 200 才收进来(2026-07-17)。
// qianfan 额外支持 glm-5.2/glm-5.1/kimi-k2.6/ernie-5.1(均为用户明确要求)。
export const MODELS_BY_PROVIDER: Record<Provider, string[]> = {
  deepseek: ["deepseek-v4-pro", "deepseek-v4-flash"],
  volcengine: [
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "doubao-seed-2.0-pro",
    "doubao-seed-2.0-lite",
    "doubao-seed-2.0-code",
    "glm-5.2",
    "kimi-k2.6",
    "kimi-k2.7-code",
    "minimax-m2.7",
    "minimax-m3",
  ],
  qianfan: ["deepseek-v4-pro", "deepseek-v4-flash", "glm-5.2", "glm-5.1", "kimi-k2.6", "ernie-5.1"],
  anthropic: [DEFAULTS.anthropic.model],
  openai: [DEFAULTS.openai.model],
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
