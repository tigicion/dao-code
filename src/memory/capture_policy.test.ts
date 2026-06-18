import { describe, it, expect } from "vitest";
import { shouldCaptureMemory } from "./capture_policy.js";

describe("shouldCaptureMemory", () => {
  const T = 15000;
  it("没新材料 → 不捕获(即便压缩在即)", () => {
    expect(shouldCaptureMemory({ newTokens: 0, threshold: T, compactionImminent: true }).capture).toBe(false);
  });
  it("压缩前 + 有新材料 → 捕获(即便未达阈值)", () => {
    const r = shouldCaptureMemory({ newTokens: 100, threshold: T, compactionImminent: true });
    expect(r).toEqual({ capture: true, reason: "pre-compaction" });
  });
  it("verify 通过 + 有新材料 → 捕获(即便未达阈值)", () => {
    const r = shouldCaptureMemory({ newTokens: 100, threshold: T, verifyPassed: true });
    expect(r).toEqual({ capture: true, reason: "verify-passed" });
  });
  it("达阈值 → 捕获", () => {
    expect(shouldCaptureMemory({ newTokens: T, threshold: T }).reason).toBe("token-threshold");
  });
  it("有新材料但未达阈值、无事件 → 跳过(多数回合)", () => {
    expect(shouldCaptureMemory({ newTokens: T - 1, threshold: T })).toEqual({ capture: false, reason: "below-threshold" });
  });
});
