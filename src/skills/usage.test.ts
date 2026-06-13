import { describe, it, expect } from "vitest";
import { recordUsage, usageScore, type UsageMap } from "./usage.js";

describe("skill usage 加权", () => {
  it("recordUsage 累加次数 + 记录日期", () => {
    let m: UsageMap = {};
    m = recordUsage(m, "pdf", "2026-06-10");
    m = recordUsage(m, "pdf", "2026-06-13");
    expect(m.pdf).toEqual({ count: 2, lastUsedAt: "2026-06-13" });
  });
  it("usageScore:7 天半衰期,刚用过≈次数,久未用衰减,最低 0.1 系数", () => {
    const m: UsageMap = { fresh: { count: 4, lastUsedAt: "2026-06-13" }, old: { count: 4, lastUsedAt: "2026-04-01" } };
    expect(usageScore(m, "fresh", "2026-06-13")).toBeCloseTo(4, 5); // 0 天:0.5^0=1 → 4
    expect(usageScore(m, "fresh", "2026-06-20")).toBeCloseTo(2, 5); // 7 天:0.5^1=0.5 → 2
    expect(usageScore(m, "old", "2026-06-13")).toBeCloseTo(0.4, 5); // 久未用:系数触底 0.1 → 0.4
    expect(usageScore(m, "never", "2026-06-13")).toBe(0); // 没记录
  });
});
