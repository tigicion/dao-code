import { describe, it, expect } from "vitest";
import { resolveExtractModel } from "./fetch_extract.js";

describe("resolveExtractModel", () => {
  it("envOverride 存在时优先于一切", () => {
    expect(resolveExtractModel("custom-model", "anthropic", "claude-opus-4-8")).toBe("custom-model");
    expect(resolveExtractModel("custom-model", "deepseek", "deepseek-v4-pro")).toBe("custom-model");
  });

  it("DeepSeek 系 provider(deepseek/volcengine/qianfan)默认用 flash 档", () => {
    expect(resolveExtractModel(undefined, "deepseek", "deepseek-v4-pro")).toBe("deepseek-v4-flash");
    expect(resolveExtractModel(undefined, "volcengine", "deepseek-v4-pro")).toBe("deepseek-v4-flash");
    expect(resolveExtractModel(undefined, "qianfan", "deepseek-v4-pro")).toBe("deepseek-v4-flash");
  });

  it("非 DeepSeek 系 provider(anthropic/openai)回退主模型", () => {
    expect(resolveExtractModel(undefined, "anthropic", "claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(resolveExtractModel(undefined, "openai", "gpt-5")).toBe("gpt-5");
  });
});
