// 凭证档案(profile)数据模型:一个 profile = { provider + 凭证 + baseUrl + 默认 model }。
// 多 key 切换 = 切 profile;多 provider = profile 带不同 provider;未来订阅 = 另一种凭证类型。
// 不引入"用户(user)"概念——DAO 是本地 CLI,DeepSeek 无账号体系,user 等于给不存在的登录服务器建模。

export type Provider = "deepseek" | "anthropic" | "openai" | "volcengine" | "qianfan" | "zhipu" | "minimax";

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
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-opus-4-8" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-5" },
  // Set the profile baseUrl to https://api.minimaxi.com/v1 for direct CN access.
  minimax: { baseUrl: "https://api.minimax.io/v1", model: "MiniMax-M3.1-Flash" },
};

// 每个 provider 已知可用的模型串(/model 命令用来做校验+循环);deepseek 只有 pro/flash 两档,
// volcengine coding plan 额外支持 doubao/glm/kimi/minimax 系列——控制台列出但实测 coding plan
// 接口返回 UnsupportedModel 的串(如 doubao-seed-code,无 2.0 后缀的旧版)不收录,
// 每条都用真实 key 打过 /chat/completions 拿到 200 才收进来(2026-07-17)。
// qianfan 额外支持 glm-5.2/glm-5.1/kimi-k2.6/ernie-5.1(均为用户明确要求)。
// ark-code-latest 为火山方舟控制台可选的编码套餐模型别名(用户明确要求,2026-08-05)。
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
    "ark-code-latest",
  ],
  qianfan: ["deepseek-v4-pro", "deepseek-v4-flash", "glm-5.2", "glm-5.1", "kimi-k2.6", "ernie-5.1"],
  // zhipu coding plan 当前两档:glm-5.3(旗舰,纯文本)+ glm-5.3-flash(多模态,支持图片输入)。
  zhipu: ["glm-5.3", "glm-5.3-flash"],
  anthropic: [DEFAULTS.anthropic.model],
  openai: [DEFAULTS.openai.model],
  minimax: ["MiniMax-M3.1-Flash", "MiniMax-M3"],
};

// 支持视觉(图片输入)的模型名集合。按模型粒度精确匹配(跨 provider)。
// 维护依据(2026-07-17 核实官方文档,2026-07-26 补充 kimi-k2.7-code 用户确认):
// - kimi-k2.6: Kimi 官方文档明确"支持图片和视频输入"
// - kimi-k2.7-code: 用户确认同样支持图片输入
// - glm-5.3-flash: 智谱官方文档标注"原生多模态模型,能够原生理解图片视频"(coding-plan/latest-model)
// - glm-5.2/glm-5.1: 智谱文档标注"输入模态:文本",不支持
// - glm-5.3: 智谱文档标注纯文本模型,不支持
// - ernie-5.1: 千帆模型列表只在"文本生成"分类,不支持
// - deepseek-v4-pro/flash: 千帆模型列表只在"文本生成"分类,不支持
export const VISION_MODELS = new Set<string>([
  "kimi-k2.6",
  "kimi-k2.7-code",
  "glm-5.3-flash",
  "minimax-m3.1-flash",
  "minimax-m3",
]);

/** 当前 model 是否支持图片输入。不在 VISION_MODELS 中的模型一律视为不支持。 */
export function supportsVision(model: string): boolean {
  return VISION_MODELS.has(model.toLowerCase());
}

// 上下文窗口默认值(tok):仅 glm-5.2 使用 200K,其他模型使用 1M。
const DEFAULT_CONTEXT_WINDOW = 1_000_000;

/**
 * 模型默认上下文窗口(tok),不区分渠道。仅 glm-5.2 为 200K,其他模型为 1M。
 * 用于初始化 CONTEXT_WINDOW 和 /model 切换时联动(用户手动 /context-window 或
 * DAO_CONTEXT_WINDOW 覆盖时,手动值优先,不随模型切换改变)。
 * 模型名忽略大小写;保留可选渠道参数以兼容现有调用。
 */
export function contextWindowFor(model: string, provider?: Provider, baseUrl?: string): number {
  const key = model.toLowerCase();
  if (key === "glm-5.2") return 200_000;
  if (/^glm-/.test(key) && provider === "deepseek" && baseUrl && baseUrl !== DEFAULTS.deepseek.baseUrl) {
    return 200_000;
  }
  if (key === "minimax-m3.1-flash" || key === "minimax-m3") return DEFAULT_CONTEXT_WINDOW;
  return DEFAULT_CONTEXT_WINDOW;
}
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
