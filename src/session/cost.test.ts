import { describe, it, expect } from "vitest";
import { estimateCostCNY, loadPrices, formatCNY, pricesFor } from "./cost.js";

describe("人民币计费", () => {
  it("按命中/未命中/输出分别计价", () => {
    const prices = { inputHit: 0.5, inputMiss: 2, output: 8 }; // ￥/1M
    // 1M 命中 + 1M 未命中 + 1M 输出 = 0.5 + 2 + 8 = ￥10.5
    const cost = estimateCostCNY({ promptTokens: 2_000_000, completionTokens: 1_000_000, cacheHitTokens: 1_000_000, cacheMissTokens: 1_000_000 }, prices);
    expect(cost).toBeCloseTo(10.5, 5);
  });
  it("未命中输入 = 总输入 - 命中(容忍 miss 字段缺失)", () => {
    const prices = { inputHit: 0.5, inputMiss: 2, output: 8 };
    const cost = estimateCostCNY({ promptTokens: 1_000_000, completionTokens: 0, cacheHitTokens: 1_000_000, cacheMissTokens: 0 }, prices);
    expect(cost).toBeCloseTo(0.5, 5); // 全命中
  });
  it("env 覆盖价格", () => {
    const p = loadPrices({ DAO_PRICE_INPUT_MISS: "4", DAO_PRICE_OUTPUT: "16" } as any);
    expect(p.inputMiss).toBe(4);
    expect(p.output).toBe(16);
    expect(p.inputHit).toBe(0.9); // 未覆盖用默认(Pro 命中价)
  });
  it("formatCNY 小额显示更多小数", () => {
    expect(formatCNY(0.004)).toContain("0.0040");
    expect(formatCNY(12.3)).toBe("￥12.30");
  });

  it("已知非 DeepSeek 模型走各自实价,而非 pro/flash 启发式", () => {
    expect(pricesFor("doubao-seed-2.0-pro")).toEqual({ inputHit: 0.64, inputMiss: 3.2, output: 16 });
    expect(pricesFor("glm-5.2")).toEqual({ inputHit: 2, inputMiss: 8, output: 28 });
    expect(pricesFor("kimi-k2.6")).toEqual({ inputHit: 1.1, inputMiss: 6.5, output: 27 });
    expect(pricesFor("ernie-5.1")).toEqual({ inputHit: 1.6, inputMiss: 4, output: 18 });
  });

  it("网关模型名归一化匹配:去 -joybuilder 后缀 + 小写", () => {
    expect(pricesFor("DeepSeek-V4-Pro-joybuilder")).toEqual({ inputHit: 0.9, inputMiss: 9, output: 27 });
    expect(pricesFor("DeepSeek-V4-Flash-joybuilder")).toEqual({ inputHit: 0.2, inputMiss: 2, output: 8.2 });
    expect(pricesFor("Claude-Opus-4.8-joybuilder")).toEqual({ inputHit: 3.4, inputMiss: 34, output: 170 });
    expect(pricesFor("Claude-Sonnet-5-joybuilder")).toEqual({ inputHit: 1.36, inputMiss: 13.6, output: 68 });
    expect(pricesFor("GLM-5.3-joybuilder")).toEqual({ inputHit: 2, inputMiss: 8, output: 28 });
    expect(pricesFor("GLM-5.2-joybuilder")).toEqual({ inputHit: 2, inputMiss: 8, output: 28 });
    expect(pricesFor("GPT-5.5-joybuilder")).toEqual({ inputHit: 3.4, inputMiss: 34, output: 204 });
  });

  it("网关模型名去 -local-joybuilder 双后缀", () => {
    expect(pricesFor("DeepSeek-V4-Pro-local-joybuilder")).toEqual({ inputHit: 0.9, inputMiss: 9, output: 27 });
  });

  it("GLM-5.3-Flash 走轻量档价", () => {
    expect(pricesFor("GLM-5.3-Flash")).toEqual({ inputHit: 0.2, inputMiss: 0.8, output: 2.8 });
  });

  it("未知模型名仍退化到 pro/flash 启发式,不报错", () => {
    expect(pricesFor("some-new-flash-model").inputMiss).toBe(2);
    expect(pricesFor("some-new-model").inputMiss).toBe(9);
  });
});
