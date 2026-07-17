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
    expect(p.inputHit).toBe(0.025); // 未覆盖用默认(Pro 命中价)
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

  it("美元计价模型按汇率折算为￥,env 可覆盖汇率", () => {
    const p = pricesFor("claude-opus-4-8", { DAO_USD_CNY_RATE: "7" } as any);
    expect(p).toEqual({ inputHit: 3.5, inputMiss: 35, output: 175 });
    const def = pricesFor("gpt-5");
    expect(def.inputMiss).toBeCloseTo(1.25 * 6.8, 5);
  });

  it("未知模型名仍退化到 pro/flash 启发式,不报错", () => {
    expect(pricesFor("some-new-flash-model").inputMiss).toBe(1);
    expect(pricesFor("some-new-model").inputMiss).toBe(3);
  });
});
