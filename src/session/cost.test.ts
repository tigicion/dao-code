import { describe, it, expect } from "vitest";
import { estimateCostCNY, loadPrices, formatCNY } from "./cost.js";

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
    expect(p.inputHit).toBe(0.5); // 未覆盖用默认
  });
  it("formatCNY 小额显示更多小数", () => {
    expect(formatCNY(0.004)).toContain("0.0040");
    expect(formatCNY(12.3)).toBe("￥12.30");
  });
});
