import { describe, it, expect } from "vitest";
import { precisionRecall, aggregate, majorityVote, relevanceGap } from "./metrics.js";

describe("precisionRecall", () => {
  it("标准 P/R/F1", () => {
    const r = precisionRecall(new Set(["a", "b", "x"]), new Set(["a", "b", "c"]));
    expect(r.p).toBeCloseTo(2 / 3); expect(r.r).toBeCloseTo(2 / 3); expect(r.f1).toBeCloseTo(2 / 3);
  });
  it("空预测 → P=0,R=0,不除零", () => {
    const r = precisionRecall(new Set(), new Set(["a"]));
    expect(r.p).toBe(0); expect(r.r).toBe(0); expect(r.f1).toBe(0);
  });
});

describe("aggregate", () => {
  it("中位/均值/极值", () => {
    const a = aggregate([1, 2, 3, 4]);
    expect(a.median).toBe(2.5); expect(a.mean).toBe(2.5); expect(a.min).toBe(1); expect(a.max).toBe(4);
  });
});

describe("majorityVote", () => {
  it("多数票 + 一致率", () => {
    expect(majorityVote([true, true, false])).toEqual({ value: true, agreement: 2 / 3 });
  });
});

describe("relevanceGap", () => {
  it("相关但未注入占比", () => {
    expect(relevanceGap(new Set(["a"]), new Set(["a", "b", "c"]))).toBeCloseTo(2 / 3);
  });
});
