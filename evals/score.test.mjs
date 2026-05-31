import { describe, it, expect } from "vitest";
import { weightedCompletion, fitTimeHorizon, metasToSamples } from "./score.mjs";

describe("weightedCompletion", () => {
  const cps = [
    { id: "a", weight: 1 },
    { id: "b", weight: 2 },
    { id: "c", weight: 3 },
  ];

  it("全部通过 → 完成度 1", () => {
    const r = weightedCompletion(cps, ["a", "b", "c"]);
    expect(r.completion).toBe(1);
    expect(r.passed).toBe(3);
    expect(r.total).toBe(3);
  });

  it("全部失败 → 完成度 0", () => {
    expect(weightedCompletion(cps, []).completion).toBe(0);
  });

  it("按权重计完成度(过 b+c=5,总 6)", () => {
    const r = weightedCompletion(cps, ["b", "c"]);
    expect(r.completion).toBeCloseTo(5 / 6, 6);
    expect(r.passed).toBe(2);
  });

  it("默认权重为 1", () => {
    const r = weightedCompletion([{ id: "x" }, { id: "y" }], ["x"]);
    expect(r.completion).toBe(0.5);
  });

  it("空 checkpoints → 完成度 0,不抛", () => {
    expect(weightedCompletion([], []).completion).toBe(0);
  });

  it("忽略不在 checkpoints 里的 passedId", () => {
    expect(weightedCompletion(cps, ["a", "zzz"]).completion).toBeCloseTo(1 / 6, 6);
  });
});

describe("fitTimeHorizon", () => {
  // 短任务成功、长任务失败,转折在 60-90 分钟之间
  const samples = [
    { humanMinutes: 5, success: true },
    { humanMinutes: 10, success: true },
    { humanMinutes: 15, success: true },
    { humanMinutes: 20, success: true },
    { humanMinutes: 30, success: true },
    { humanMinutes: 60, success: true },
    { humanMinutes: 90, success: false },
    { humanMinutes: 120, success: false },
    { humanMinutes: 180, success: false },
    { humanMinutes: 240, success: false },
  ];

  it("p50 落在转折区间内(30–120 分钟)", () => {
    const { p50 } = fitTimeHorizon(samples);
    expect(p50).toBeGreaterThan(30);
    expect(p50).toBeLessThan(120);
  });

  it("p80 比 p50 短(更高可靠性要求 → 更短任务)", () => {
    const { p50, p80 } = fitTimeHorizon(samples);
    expect(p80).toBeGreaterThan(0);
    expect(p80).toBeLessThan(p50);
  });

  it("全部成功 → degenerate(数据未覆盖失败区间)", () => {
    const r = fitTimeHorizon([
      { humanMinutes: 1, success: true },
      { humanMinutes: 2, success: true },
    ]);
    expect(r.degenerate).toBe(true);
  });

  it("全部失败 → degenerate", () => {
    const r = fitTimeHorizon([
      { humanMinutes: 100, success: false },
      { humanMinutes: 200, success: false },
    ]);
    expect(r.degenerate).toBe(true);
  });

  it("样本不足(<4)→ degenerate", () => {
    expect(fitTimeHorizon([{ humanMinutes: 10, success: true }]).degenerate).toBe(true);
  });
});

describe("metasToSamples", () => {
  const metas = [
    { humanMinutes: 30, completion: 1 },
    { humanMinutes: 30, completion: 0.6 },
    { humanMinutes: 120, completion: 0.4 },
    { humanMinutes: null, completion: 1 }, // 未标注工时 → 剔除
    { humanMinutes: 90, completion: 1 },
  ];

  it("剔除未标注 humanMinutes 的记录", () => {
    expect(metasToSamples(metas, 1).length).toBe(4);
  });

  it("success 按完成度阈值判定(阈值 1 = 必须满分)", () => {
    const s = metasToSamples(metas, 1);
    expect(s.find((x) => x.humanMinutes === 30 && x.completion === 1).success).toBe(true);
    expect(s.find((x) => x.completion === 0.6).success).toBe(false);
  });

  it("阈值 0.5 时部分完成也算成功", () => {
    const s = metasToSamples(metas, 0.5);
    expect(s.find((x) => x.completion === 0.6).success).toBe(true);
    expect(s.find((x) => x.completion === 0.4).success).toBe(false);
  });
});
