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
});
