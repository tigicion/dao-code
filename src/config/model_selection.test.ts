import { describe, expect, it } from "vitest";
import { DEFAULTS, type Provider } from "./profiles.js";
import { defaultAuxiliaryModel, getAgentModel } from "./model_selection.js";

describe("模型选择", () => {
  it.each(Object.keys(DEFAULTS) as Provider[])("%s 的自定义端点保留主模型完整 ID", (provider) => {
    for (const model of ["GLM-5.3-Flash-joybuilder", "deepseek-v4-pro", "glm-5.3"]) {
      expect(defaultAuxiliaryModel({ provider, baseUrl: "https://gateway.example/v1", model })).toBe(model);
    }
  });
  it.each(["anthropic", "openai", "volcengine", "qianfan"] as Provider[])("%s 的非 DeepSeek 主模型不会被换成 DeepSeek", (provider) => {
    const model = provider === "anthropic" || provider === "openai" ? DEFAULTS[provider].model : "kimi-k2.8-preview";
    expect(defaultAuxiliaryModel({ provider, baseUrl: DEFAULTS[provider].baseUrl, model })).toBe(model);
  });
  it("已知官方端点保留同族便宜档，尾斜线不影响识别", () => {
    expect(defaultAuxiliaryModel({ provider: "deepseek", ...DEFAULTS.deepseek })).toBe("deepseek-flash");
    expect(defaultAuxiliaryModel({ provider: "zhipu", model: "glm-5.3", baseUrl: DEFAULTS.zhipu.baseUrl + "/" })).toBe("glm-5.3-flash");
  });
  it("各 DeepSeek 渠道选择当前 Flash,自定义网关仍保留原 ID", () => {
    for (const provider of ["volcengine", "qianfan"] as const) {
      for (const model of ["deepseek-v4-pro", "deepseek-v4-pro-0813", "deepseek-v4.1-flash-1017"]) {
        expect(defaultAuxiliaryModel({ provider, baseUrl: DEFAULTS[provider].baseUrl, model })).toBe("deepseek-v4.1-flash");
      }
    }
  });
  it("缺少主模型时禁止猜测，显式定义仍可使用", () => {
    expect(() => getAgentModel(undefined, undefined)).toThrow("缺少可继承的主模型");
    expect(() => getAgentModel("inherit", " ")).toThrow("缺少可继承的主模型");
    expect(getAgentModel("gateway-pro", undefined)).toBe("gateway-pro");
    expect(getAgentModel("configured", "current", " INHERIT ")).toBe("current");
  });
});
