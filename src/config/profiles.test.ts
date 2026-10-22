import { describe, it, expect } from "vitest";
import { migrateConfig, resolveActive, DEFAULTS, MODELS_BY_PROVIDER, supportsVision, contextWindowFor, outputLimitFor } from "./profiles.js";

describe("migrateConfig", () => {
  it("wraps a legacy { apiKey } config into a default deepseek profile", () => {
    const out = migrateConfig({ apiKey: "sk-legacy", baseUrl: "https://x", model: "m1" });
    expect(out.version).toBe(2);
    expect(out.activeProfile).toBe("default");
    expect(out.profiles.default).toEqual({
      provider: "deepseek",
      baseUrl: "https://x",
      model: "m1",
      key: "sk-legacy",
    });
  });

  it("fills baseUrl/model defaults when the legacy config omits them", () => {
    const out = migrateConfig({ apiKey: "sk-legacy" });
    expect(out.profiles.default!.baseUrl).toBe(DEFAULTS.deepseek.baseUrl);
    expect(out.profiles.default!.model).toBe(DEFAULTS.deepseek.model);
  });

  it("produces an empty profile set when no key is stored", () => {
    const out = migrateConfig({ baseUrl: "https://x" });
    expect(out.profiles).toEqual({});
    expect(out.activeProfile).toBe("default");
  });

  it("returns a v2 config unchanged", () => {
    const v2 = {
      version: 2 as const,
      onboardingComplete: true,
      activeProfile: "work",
      profiles: {
        work: { provider: "deepseek" as const, baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro", key: "sk-w" },
      },
    };
    expect(migrateConfig(v2)).toEqual(v2);
  });

  it("treats a corrupt/empty value as a fresh config", () => {
    expect(migrateConfig(null).profiles).toEqual({});
    expect(migrateConfig(undefined).profiles).toEqual({});
  });
});

describe("resolveActive", () => {
  const cfg = {
    version: 2 as const,
    activeProfile: "personal",
    profiles: {
      personal: { provider: "deepseek" as const, baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro", key: "sk-personal" },
      work: { provider: "deepseek" as const, baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro", key: "sk-work" },
    },
  };

  it("uses the active profile's credential and reports its source", () => {
    const r = resolveActive(cfg);
    expect(r).toEqual({
      key: "sk-personal",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      source: "profile:personal",
    });
  });

  it("returns null when the active profile has no key", () => {
    const empty = { version: 2 as const, activeProfile: "default", profiles: {} };
    expect(resolveActive(empty)).toBeNull();
  });
});

describe("DEFAULTS.volcengine", () => {
  it("points at the coding-plan base url with deepseek-v4-pro as default model", () => {
    expect(DEFAULTS.volcengine).toEqual({
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
      model: "deepseek-v4-pro",
    });
  });
});

describe("DEFAULTS.qianfan", () => {
  it("points at the token-plan base url with deepseek-v4-pro as default model", () => {
    expect(DEFAULTS.qianfan).toEqual({
      baseUrl: "https://qianfan.baidubce.com/v2/tokenplan/personal",
      model: "deepseek-v4-pro",
    });
  });
});

describe("DEFAULTS.zhipu", () => {
  it("points at the coding-plan base url with glm-5.3 as default model", () => {
    expect(DEFAULTS.zhipu).toEqual({
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      model: "glm-5.3",
    });
  });
});

describe("MODELS_BY_PROVIDER", () => {
  it("各渠道默认模型均可选,模型 ID 唯一且窗口有效", () => {
    for (const [provider, models] of Object.entries(MODELS_BY_PROVIDER)) {
      expect(models.some(m => m.id === DEFAULTS[provider as keyof typeof DEFAULTS].model)).toBe(true);
      expect(new Set(models.map(m => m.id)).size).toBe(models.length);
      expect(models.every(m => Number.isSafeInteger(m.contextWindow) && m.contextWindow > 0)).toBe(true);
    }
  });
  it("OpenAI 当前三档模型都有明确的窗口和视觉能力", () => {
    for (const id of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]) {
      expect(contextWindowFor(id)).toBe(1_050_000);
      expect(supportsVision(id)).toBe(true);
    }
    expect(contextWindowFor("ark-code-latest")).toBe(256_000);
    expect(supportsVision("DOUBAO-SEED-2.1-PRO")).toBe(true);
    expect(supportsVision("doubao-seed-2.0-mini")).toBe(true);
    expect(contextWindowFor("ernie-5.1", "qianfan")).toBe(128_000);
    expect(outputLimitFor("ernie-5.1", 128000)).toBe(65536);
    expect(outputLimitFor("ark-code-latest", 128000)).toBe(32000);
    expect(outputLimitFor("unknown-model", 256000)).toBe(256000);
  });

  it("qianfan 保留官方列出的版本号与 GLM,并兼容既有账户模型", () => {
    expect(MODELS_BY_PROVIDER.qianfan.map(m => m.id)).toEqual([
      "deepseek-v4-pro", "deepseek-v4.1-flash-1017", "deepseek-v4.1-flash",
      "deepseek-v4-pro-0813", "deepseek-v4-flash-0731", "glm-5.3", "glm-5.3-flash",
      "glm-5.2", "glm-5.1", "kimi-k2.6", "ernie-5.1",
    ]);
  });
  it("deepseek 只有 pro/flash 两档", () => {
    expect(MODELS_BY_PROVIDER.deepseek.map(m => m.id)).toEqual(["deepseek-v4-pro", "deepseek-flash"]);
  });
  it("volcengine coding plan 额外支持 doubao/glm/kimi 系列(与 pro/flash 并列,2026-10-22 文档同步)", () => {
    expect(MODELS_BY_PROVIDER.volcengine.map(m => m.id)).toEqual([
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "deepseek-v4.1-flash",
      "deepseek-v4.1-flash-economy",
      "doubao-seed-2.1-pro",
      "doubao-seed-2.1-lite",
      "doubao-seed-2.0-mini",
      "doubao-seed-evolving",
      "glm-5.3",
      "glm-5.3-flash",
      "kimi-k2.8-preview",
      "kimi-k3",
      "ark-code-latest",
    ]);
  });
  it("zhipu coding plan 两档:glm-5.3 + glm-5.3-flash", () => {
    expect(MODELS_BY_PROVIDER.zhipu.map(m => m.id)).toEqual(["glm-5.3", "glm-5.3-flash"]);
  });
});

describe("supportsVision", () => {
  it("deepseek-v4.1 系与 kimi-k2.8/k3 支持视觉", () => {
    expect(supportsVision("deepseek-v4.1-flash")).toBe(true);
    expect(supportsVision("deepseek-v4.1-flash-economy")).toBe(true);
    expect(supportsVision("kimi-k2.8-preview")).toBe(true);
    expect(supportsVision("kimi-k3")).toBe(true);
  });
  it("glm-5.3-flash(多模态)支持视觉", () => {
    expect(supportsVision("glm-5.3-flash")).toBe(true);
  });
  it("deepseek-v4-pro 等非视觉模型返回 false", () => {
    expect(supportsVision("deepseek-v4-pro")).toBe(false);
    expect(supportsVision("glm-5.2")).toBe(false);
    expect(supportsVision("glm-5.3")).toBe(false);
    expect(supportsVision("unknown-model")).toBe(false);
  });
});

describe("contextWindowFor", () => {
  it("旧网关 glm-5.2 保持 200K,官方渠道使用公布窗口", () => {
    expect(contextWindowFor("glm-5.2")).toBe(200_000);
    expect(contextWindowFor("GLM-5.2")).toBe(200_000);
    expect(contextWindowFor("glm-5.2", "zhipu", DEFAULTS.zhipu.baseUrl)).toBe(200_000);
    expect(contextWindowFor("glm-5.2", "qianfan", DEFAULTS.qianfan.baseUrl)).toBe(1_000_000);
    expect(contextWindowFor("GLM-5.3-Flash")).toBe(1_000_000);
    expect(contextWindowFor("glm-5.3-flash")).toBe(1_000_000);
    expect(contextWindowFor("glm-5.3")).toBe(1_000_000);
    expect(contextWindowFor("glm-5.2", "volcengine", DEFAULTS.volcengine.baseUrl)).toBe(200_000);
    expect(contextWindowFor("glm-5.1", "qianfan", DEFAULTS.qianfan.baseUrl)).toBe(198_000);
  });
  it("doubao-seed-2.0-mini 为 256K(官方文档),忽略大小写", () => {
    expect(contextWindowFor("doubao-seed-2.0-mini")).toBe(256_000);
    expect(contextWindowFor("Doubao-Seed-2.0-Mini", "volcengine", DEFAULTS.volcengine.baseUrl)).toBe(256_000);
    expect(contextWindowFor("doubao-seed-2.1-pro")).toBe(1_024_000);
  });
  it("GLM 系列按渠道区分:zhipu 官方 coding plan 按官方文档一律 1M", () => {
    expect(contextWindowFor("glm-5.3", "zhipu", DEFAULTS.zhipu.baseUrl)).toBe(1_000_000);
    expect(contextWindowFor("glm-5.3-flash", "zhipu", DEFAULTS.zhipu.baseUrl)).toBe(1_000_000);
    expect(contextWindowFor("GLM-5.3-Flash", "zhipu", DEFAULTS.zhipu.baseUrl)).toBe(1_000_000);
  });
  it("自定义网关同样仅 glm-5.2 为 200K,GLM-5.3-joybuilder 为 1M", () => {
    expect(contextWindowFor("glm-5.3", "deepseek", "http://llm-gw.jd.local/v1")).toBe(1_000_000);
    expect(contextWindowFor("GLM-5.3-joybuilder", "deepseek", "http://llm-gw.jd.local/v1")).toBe(1_000_000);
    expect(contextWindowFor("glm-5.3-flash", "deepseek", "https://gw.example.com/v1")).toBe(1_000_000);
    expect(contextWindowFor("glm-5.2", "deepseek", "https://gw.example.com/v1")).toBe(200_000);
  });
  it("deepseek 官方 baseUrl 不触发网关保守值(GLM 系列按 1M)", () => {
    expect(contextWindowFor("glm-5.3", "deepseek", DEFAULTS.deepseek.baseUrl)).toBe(1_000_000);
  });
  it("其他模型默认 1M", () => {
    expect(contextWindowFor("deepseek-v4-pro")).toBe(1_000_000);
    expect(contextWindowFor("deepseek-v4-flash")).toBe(1_000_000);
    expect(contextWindowFor("kimi-k2.6")).toBe(256_000);
    expect(contextWindowFor("unknown-model")).toBe(1_000_000);
  });
});
