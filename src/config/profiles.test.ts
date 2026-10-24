import { describe, it, expect } from "vitest";
import { migrateConfig, resolveActive, DEFAULTS, MODELS_BY_PROVIDER, supportsVision, contextWindowFor } from "./profiles.js";

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

describe("DEFAULTS.minimax", () => {
  it("uses the global direct endpoint and Flash-first M3 default", () => {
    expect(DEFAULTS.minimax).toEqual({
      baseUrl: "https://api.minimax.io/v1",
      model: "MiniMax-M3.1-Flash",
    });
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
  it("qianfan 额外支持 glm-5.2/glm-5.1/kimi-k2.6/ernie-5.1(与 pro/flash 并列)", () => {
    expect(MODELS_BY_PROVIDER.qianfan).toEqual([
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "glm-5.2",
      "glm-5.1",
      "kimi-k2.6",
      "ernie-5.1",
    ]);
  });
  it("deepseek 只有 pro/flash 两档", () => {
    expect(MODELS_BY_PROVIDER.deepseek).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
  });
  it("volcengine coding plan 额外支持 doubao/glm/kimi/minimax 系列(与 pro/flash 并列)", () => {
    expect(MODELS_BY_PROVIDER.volcengine).toEqual([
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
    ]);
  });
  it("zhipu coding plan 两档:glm-5.3 + glm-5.3-flash", () => {
    expect(MODELS_BY_PROVIDER.zhipu).toEqual(["glm-5.3", "glm-5.3-flash"]);
  });
  it("MiniMax direct is Flash-first and keeps M3 as the second owned choice", () => {
    expect(MODELS_BY_PROVIDER.minimax).toEqual(["MiniMax-M3.1-Flash", "MiniMax-M3"]);
  });
});

describe("supportsVision", () => {
  it("kimi-k2.6 和 kimi-k2.7-code 都支持视觉", () => {
    expect(supportsVision("kimi-k2.6")).toBe(true);
    expect(supportsVision("kimi-k2.7-code")).toBe(true);
  });
  it("glm-5.3-flash(多模态)支持视觉", () => {
    expect(supportsVision("glm-5.3-flash")).toBe(true);
  });
  it("MiniMax M3.1 Flash and M3 support image input", () => {
    expect(supportsVision("MiniMax-M3.1-Flash")).toBe(true);
    expect(supportsVision("MiniMax-M3")).toBe(true);
    expect(supportsVision("minimax-m3.1-flash")).toBe(true);
  });
  it("deepseek-v4-pro 等非视觉模型返回 false", () => {
    expect(supportsVision("deepseek-v4-pro")).toBe(false);
    expect(supportsVision("glm-5.2")).toBe(false);
    expect(supportsVision("glm-5.3")).toBe(false);
    expect(supportsVision("unknown-model")).toBe(false);
  });
});

describe("contextWindowFor", () => {
  it("仅 glm-5.2 为 200K,忽略大小写且不区分渠道", () => {
    expect(contextWindowFor("glm-5.2")).toBe(200_000);
    expect(contextWindowFor("GLM-5.2")).toBe(200_000);
    expect(contextWindowFor("glm-5.2", "zhipu", DEFAULTS.zhipu.baseUrl)).toBe(200_000);
    expect(contextWindowFor("glm-5.2", "qianfan", DEFAULTS.qianfan.baseUrl)).toBe(200_000);
    expect(contextWindowFor("GLM-5.3-Flash")).toBe(1_000_000);
    expect(contextWindowFor("glm-5.3-flash")).toBe(1_000_000);
    expect(contextWindowFor("glm-5.3")).toBe(1_000_000);
    expect(contextWindowFor("glm-5.2", "volcengine", DEFAULTS.volcengine.baseUrl)).toBe(200_000);
    expect(contextWindowFor("glm-5.1", "qianfan", DEFAULTS.qianfan.baseUrl)).toBe(1_000_000);
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
    expect(contextWindowFor("kimi-k2.6")).toBe(1_000_000);
    expect(contextWindowFor("MiniMax-M3.1-Flash")).toBe(1_000_000);
    expect(contextWindowFor("MiniMax-M3")).toBe(1_000_000);
    expect(contextWindowFor("unknown-model")).toBe(1_000_000);
  });
});
