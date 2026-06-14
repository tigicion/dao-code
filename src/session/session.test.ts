import { describe, it, expect } from "vitest";
import { Session } from "./session.js";

describe("Session", () => {
  it("starts with the system prompt and given model", () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    expect(s.messages).toEqual([{ role: "system", content: "SYS" }]);
    expect(s.model).toBe("deepseek-v4-pro");
    expect(s.mode).toBe("normal");
  });

  it("appends user messages", () => {
    const s = new Session("SYS", "m");
    s.addUser("hi");
    expect(s.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
    ]);
  });

  it("clear resets to just the system prompt", () => {
    const s = new Session("SYS", "m");
    s.addUser("a");
    s.messages.push({ role: "assistant", content: "b" });
    s.clear();
    expect(s.messages).toEqual([{ role: "system", content: "SYS" }]);
  });

  it("setModel changes the model without touching messages", () => {
    const s = new Session("SYS", "m");
    s.addUser("a");
    s.setModel("deepseek-v4-flash");
    expect(s.model).toBe("deepseek-v4-flash");
    expect(s.messages).toHaveLength(2);
  });

  it("toggleMode flips between normal and plan", () => {
    const s = new Session("SYS", "m");
    expect(s.toggleMode()).toBe("plan");
    expect(s.mode).toBe("plan");
    expect(s.toggleMode()).toBe("normal");
  });

  it("accumulates usage and computes cache hit ratio", () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUsage({ prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 });
    s.addUsage({ prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 });
    expect(s.usage.promptTokens).toBe(2000);
    expect(s.usage.completionTokens).toBe(100);
    expect(s.usage.cacheHitTokens).toBe(1700);
    expect(s.cacheHitRatio()).toBeCloseTo(0.85);
    expect(s.usageSummary()).toMatch(/命中率 85\.0%/);
  });

  it("tolerates missing cache fields and empty sessions", () => {
    const s = new Session("S", "m");
    s.addUsage({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
    expect(s.usage.cacheHitTokens).toBe(0);
    expect(s.cacheHitRatio()).toBe(0);
    expect(new Session("S", "m").usageSummary()).toMatch(/暂无/);
  });

  // P0-1 缓存埋点:前缀缓存被改写时,某一回合命中率会从高位骤降。onCacheBust 应能捕获到,
  // 用于在 --verbose 下暴露"压缩/注入意外破了前缀缓存"。
  it("onCacheBust fires when a high cache-hit prefix suddenly collapses", () => {
    const s = new Session("S", "m");
    const hits: { from: number; to: number; promptTokens: number }[] = [];
    s.onCacheBust((info) => hits.push(info));
    // 第一回合:大输入、高命中(前缀缓存健康)
    s.addUsage({ prompt_tokens: 20000, completion_tokens: 10, total_tokens: 20010, prompt_cache_hit_tokens: 19000, prompt_cache_miss_tokens: 1000 });
    expect(hits).toHaveLength(0);
    // 第二回合:命中率骤降(前缀被改写)→ 触发
    s.addUsage({ prompt_tokens: 21000, completion_tokens: 10, total_tokens: 21010, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 20000 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.from).toBeCloseTo(0.95, 1);
    expect(hits[0]!.to).toBeCloseTo(0.05, 1);
  });

  it("onCacheBust does NOT fire on a healthy or first/small turn", () => {
    const s = new Session("S", "m");
    const hits: unknown[] = [];
    s.onCacheBust(() => hits.push(1));
    // 首轮天然 0 命中(无前缀),不应误报
    s.addUsage({ prompt_tokens: 18000, completion_tokens: 5, total_tokens: 18005, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 18000 });
    // 持续健康
    s.addUsage({ prompt_tokens: 19000, completion_tokens: 5, total_tokens: 19005, prompt_cache_hit_tokens: 18000, prompt_cache_miss_tokens: 1000 });
    s.addUsage({ prompt_tokens: 20000, completion_tokens: 5, total_tokens: 20005, prompt_cache_hit_tokens: 19000, prompt_cache_miss_tokens: 1000 });
    // 小输入回合即便命中低也不报(省得首问/短问误触)
    s.addUsage({ prompt_tokens: 500, completion_tokens: 5, total_tokens: 505, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 500 });
    expect(hits).toHaveLength(0);
  });
});
