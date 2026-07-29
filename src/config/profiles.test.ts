import { describe, it, expect } from "vitest";
import { migrateConfig, resolveActive, DEFAULTS, MODELS_BY_PROVIDER, supportsVision, resolveContextWindow } from "./profiles.js";

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
    ]);
  });
  it("minimax 直连保留官方大小写 ID(MiniMax-M3/MiniMax-M2.7)", () => {
    expect(MODELS_BY_PROVIDER.minimax).toEqual(["MiniMax-M3", "MiniMax-M2.7"]);
  });
});

describe("DEFAULTS.minimax", () => {
  it("points at the official global OpenAI-compatible base url with MiniMax-M3 as default model", () => {
    expect(DEFAULTS.minimax).toEqual({
      baseUrl: "https://api.minimax.io/v1",
      model: "MiniMax-M3",
    });
  });
});

describe("supportsVision", () => {
  it("MiniMax-M3 supports image/video input; MiniMax-M2.7 does not", () => {
    expect(supportsVision("MiniMax-M3")).toBe(true);
    expect(supportsVision("MiniMax-M2.7")).toBe(false);
  });
});

describe("resolveContextWindow", () => {
  it("resolves each MiniMax model's real window instead of the flat 1M default", () => {
    expect(resolveContextWindow("MiniMax-M3")).toBe(1_000_000);
    expect(resolveContextWindow("MiniMax-M2.7")).toBe(204_800);
  });
  it("falls back to the 1M default for unregistered models", () => {
    expect(resolveContextWindow("deepseek-v4-pro")).toBe(1_000_000);
  });
});
