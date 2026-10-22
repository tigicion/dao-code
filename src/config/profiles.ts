// 凭证档案(profile)数据模型:一个 profile = { provider + 凭证 + baseUrl + 默认 model }。
// 多 key 切换 = 切 profile;多 provider = profile 带不同 provider;未来订阅 = 另一种凭证类型。
// 不引入"用户(user)"概念——DAO 是本地 CLI,DeepSeek 无账号体系,user 等于给不存在的登录服务器建模。

export type Provider = "deepseek" | "anthropic" | "openai" | "volcengine" | "qianfan" | "zhipu";

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
  // 智谱 GLM 编码套餐(Coding Plan):套餐 key 须打专属 Coding 端点(OpenAI Chat Completion 协议),
  // 与平台通用端点 open.bigmodel.cn/api/paas/v4 的 key 不通用(官方文档 coding-plan/quick-start)。
  zhipu: { baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", model: "glm-5.3" },
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-6-astra" },
};

// 模型自身的属性:上下文窗口与是否支持图片输入不再是散落的 if-else/Set 平行结构,
// 而是模型条目的字段——加新模型必须显式写 contextWindow(漏写直接编译不过)。
export interface ModelInfo {
  id: string;
  contextWindow: number; // tok
  vision?: boolean; // 支持图片输入
  maxOutputTokens?: number; // 已核实的输出上限,省略时沿用调用方设置
}

// 核对日期 2026-10-22;来源与兼容策略见 docs/architecture/models.md。
// 清单只包含编码/工具调用模型;旧网关模型属性另行保留,不把路由别名当成固定模型。
export const MODELS_BY_PROVIDER: Record<Provider, ModelInfo[]> = {
  deepseek: [
    { id: "deepseek-v4-pro", contextWindow: 1_000_000 },
    { id: "deepseek-flash", contextWindow: 1_000_000, vision: true },
  ],
  volcengine: [
    { id: "deepseek-v4-pro", contextWindow: 1_000_000 },
    { id: "deepseek-v4-flash", contextWindow: 1_000_000 },
    { id: "deepseek-v4.1-flash", contextWindow: 1_000_000, vision: true },
    { id: "deepseek-v4.1-flash-economy", contextWindow: 1_000_000, vision: true },
    { id: "doubao-seed-2.1-pro", contextWindow: 1_024_000, vision: true },
    { id: "doubao-seed-2.1-lite", contextWindow: 1_024_000, vision: true },
    { id: "doubao-seed-2.0-mini", contextWindow: 256_000, vision: true },
    { id: "doubao-seed-evolving", contextWindow: 1_024_000, vision: true },
    { id: "glm-5.3", contextWindow: 1_000_000 },
    { id: "glm-5.3-flash", contextWindow: 1_000_000, vision: true },
    { id: "kimi-k2.8-preview", contextWindow: 1_000_000, vision: true },
    { id: "kimi-k3", contextWindow: 1_000_000, vision: true },
    // 控制台路由可变:采用官方工具配置的保守窗口,切换目标后可 /context-window 覆盖。
    { id: "ark-code-latest", contextWindow: 256_000, vision: true, maxOutputTokens: 32_000 },
  ],
  qianfan: [
    { id: "deepseek-v4-pro", contextWindow: 1_000_000 },
    { id: "deepseek-v4.1-flash-1017", contextWindow: 1_000_000, vision: true },
    { id: "deepseek-v4.1-flash", contextWindow: 1_000_000, vision: true },
    { id: "deepseek-v4-pro-0813", contextWindow: 1_000_000 },
    { id: "deepseek-v4-flash-0731", contextWindow: 1_000_000 },
    { id: "glm-5.3", contextWindow: 1_000_000 },
    { id: "glm-5.3-flash", contextWindow: 1_000_000, vision: true },
    { id: "glm-5.2", contextWindow: 1_000_000 },
    { id: "glm-5.1", contextWindow: 198_000 },
    // 既有账户兼容项,非当前 Token Plan 公布清单;不推断已退役。
    { id: "kimi-k2.6", contextWindow: 256_000, vision: true },
    { id: "ernie-5.1", contextWindow: 128_000, maxOutputTokens: 65_536 },
  ],
  zhipu: [
    { id: "glm-5.3", contextWindow: 1_000_000 },
    { id: "glm-5.3-flash", contextWindow: 1_000_000, vision: true },
  ],
  anthropic: [
    { id: "claude-opus-5-5", contextWindow: 1_000_000, vision: true },
    { id: "claude-fable-5-1", contextWindow: 1_000_000, vision: true },
    { id: "claude-sonnet-5-5", contextWindow: 1_000_000, vision: true },
    { id: "claude-haiku-5-5", contextWindow: 1_000_000, vision: true },
  ],
  openai: [
    { id: "gpt-6-astra", contextWindow: 1_050_000, vision: true, maxOutputTokens: 128_000 },
    { id: "gpt-6.1-sol", contextWindow: 1_050_000, vision: true, maxOutputTokens: 128_000 },
    { id: "gpt-6-luna", contextWindow: 1_050_000, vision: true, maxOutputTokens: 128_000 },
    { id: "gpt-5", contextWindow: 400_000, vision: true, maxOutputTokens: 128_000 },
  ],
};

// 自定义网关的兼容属性(如京东网关的 GLM-5.2),独立于官方渠道当前公布的窗口。
// 这张表不增加 /model 选择项,只为能力查询保留旧模型。
// 旧模型维持已验证行为;渠道已停止推荐的型号不影响自定义网关的使用。
const LEGACY_MODELS: readonly ModelInfo[] = [
  { id: "glm-5.2", contextWindow: 200_000 },
  { id: "glm-5.1", contextWindow: 1_000_000 },
  { id: "kimi-k2.7-code", contextWindow: 256_000, vision: true, maxOutputTokens: 32_000 },
  { id: "minimax-m3", contextWindow: 1_000_000, vision: true },
];

// 未知模型(自定义网关,如 GLM-5.3-joybuilder)的窗口回退值。
const DEFAULT_CONTEXT_WINDOW = 1_000_000;

// 扁平索引:小写模型 id → 属性;显式兼容属性最后覆盖。
const MODEL_INDEX: ReadonlyMap<string, ModelInfo> = new Map(
  [...Object.values(MODELS_BY_PROVIDER).flat(), ...LEGACY_MODELS].map(
    (m) => [m.id.toLowerCase(), m] as const,
  ),
);

// 支持图片输入的模型名(提示文案展示用);查表判断走 supportsVision。
export const VISION_MODEL_IDS: readonly string[] = [
  ...new Set(
    [...Object.values(MODELS_BY_PROVIDER).flat(), ...LEGACY_MODELS]
      .filter((m) => m.vision)
      .map((m) => m.id),
  ),
];

/** 当前 model 是否支持图片输入。不在索引中的模型一律视为不支持。 */
export function supportsVision(model: string): boolean {
  return MODEL_INDEX.get(model.toLowerCase())?.vision === true;
}

/**
 * 官方端点优先使用渠道公布窗口;自定义网关使用已验证的兼容属性,未知模型回退 1M。
 * 用于初始化 CONTEXT_WINDOW 和 /model 切换时联动(用户手动 /context-window 或
 * DAO_CONTEXT_WINDOW 覆盖时,手动值优先,不随模型切换改变)。
 * 模型名忽略大小写;保留可选渠道参数以兼容现有调用。
 */
export function contextWindowFor(model: string, provider?: Provider, baseUrl?: string): number {
  return modelInfoFor(model, provider, baseUrl)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

function modelInfoFor(model: string, provider?: Provider, baseUrl?: string): ModelInfo | undefined {
  const normalizedBase = baseUrl?.replace(/\/+$/, "");
  provider ??= (Object.keys(DEFAULTS) as Provider[]).find(key => DEFAULTS[key].baseUrl === normalizedBase);
  if (provider && (!baseUrl || baseUrl.replace(/\/+$/, "") === DEFAULTS[provider].baseUrl)) {
    const info = MODELS_BY_PROVIDER[provider].find(m => m.id.toLowerCase() === model.toLowerCase());
    if (info) return info;
  }
  return MODEL_INDEX.get(model.toLowerCase());
}

/** 限制已知模型的输出天花板,避免长输出重试发送超过服务端上限的预算。 */
export function outputLimitFor(model: string, requested: number, baseUrl?: string): number {
  return Math.min(requested, modelInfoFor(model, undefined, baseUrl)?.maxOutputTokens ?? requested);
}

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
