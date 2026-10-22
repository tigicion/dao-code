import { describe, it, expect } from "vitest";
import { resolveExtractModel } from "./fetch_extract.js";
import { DEFAULTS } from "../config/profiles.js";

describe("resolveExtractModel", () => {
  it("envOverride 存在时优先于一切", () => {
    expect(resolveExtractModel("custom-model", "anthropic", "claude-opus-4-8")).toBe("custom-model");
    expect(resolveExtractModel("custom-model", "deepseek", "deepseek-v4-pro")).toBe("custom-model");
  });

  it("DeepSeek 系 provider(deepseek/volcengine/qianfan)默认用 flash 档", () => {
    expect(resolveExtractModel(undefined, "deepseek", "deepseek-v4-pro", DEFAULTS.deepseek.baseUrl)).toBe("deepseek-flash");
    expect(resolveExtractModel(undefined, "volcengine", "deepseek-v4-pro", DEFAULTS.volcengine.baseUrl)).toBe("deepseek-v4.1-flash");
    expect(resolveExtractModel(undefined, "qianfan", "deepseek-v4-pro", DEFAULTS.qianfan.baseUrl)).toBe("deepseek-v4.1-flash");
  });

  it("zhipu 默认用同族便宜档 glm-5.3-flash(端点没有 deepseek 系模型)", () => {
    expect(resolveExtractModel(undefined, "zhipu", "glm-5.3", DEFAULTS.zhipu.baseUrl)).toBe("glm-5.3-flash");
  });
  it("缺少端点或自定义网关继承主模型，显式 inherit 优先于便宜档", () => {
    expect(resolveExtractModel(undefined, "deepseek", "gateway-model")).toBe("gateway-model");
    expect(resolveExtractModel(undefined, "zhipu", "glm-5.3", "https://gateway.example")).toBe("glm-5.3");
    expect(resolveExtractModel("inherit", "deepseek", "deepseek-v4-pro", DEFAULTS.deepseek.baseUrl)).toBe("deepseek-v4-pro");
  });

  it("非 DeepSeek 系 provider(anthropic/openai)回退主模型", () => {
    expect(resolveExtractModel(undefined, "anthropic", "claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(resolveExtractModel(undefined, "openai", "gpt-5")).toBe("gpt-5");
  });
});
