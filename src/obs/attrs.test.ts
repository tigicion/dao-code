import { describe, it, expect } from "vitest";
import { llmAttributes, cacheTag, cacheLow } from "./attrs.js";
import type { Usage } from "../client/types.js";

describe("llmAttributes", () => {
  it("含 model 且无 usage 时只写 model", () => {
    expect(llmAttributes("deepseek-chat")).toEqual({
      "gen_ai.request.model": "deepseek-chat",
    });
  });
  it("有 usage 时写全 token 计数", () => {
    const u: Usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
    expect(llmAttributes("m", u)).toEqual({
      "gen_ai.request.model": "m",
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20,
      "llm.usage.total_tokens": 120,
    });
  });
});

describe("cacheTag", () => {
  it("hit>0 → cache_hit", () => {
    expect(cacheTag({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, prompt_cache_hit_tokens: 50 })).toBe("cache_hit");
  });
  it("hit=0 且有 miss → cache_miss", () => {
    expect(cacheTag({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 30 })).toBe("cache_miss");
  });
  it("无 cache 字段 → undefined", () => {
    expect(cacheTag({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })).toBeUndefined();
  });
  it("undefined usage → undefined", () => {
    expect(cacheTag(undefined)).toBeUndefined();
  });
});

describe("cacheLow", () => {
  const u = (prompt: number, hit: number): any => ({ prompt_tokens: prompt, completion_tokens: 1, total_tokens: prompt + 1, prompt_cache_hit_tokens: hit });
  it("大上下文低命中(20% < 50%)→ 返回 hit_rate/prompt_tokens", () => {
    expect(cacheLow(u(20000, 4000))).toEqual({ hit_rate: 0.2, prompt_tokens: 20000 });
  });
  it("命中率达标(90%)→ null", () => {
    expect(cacheLow(u(20000, 18000))).toBeNull();
  });
  it("小/冷调用(低于 floor)即便命中低也 → null(冷启动不算异常)", () => {
    expect(cacheLow(u(100, 0))).toBeNull();
  });
  it("undefined usage → null", () => {
    expect(cacheLow(undefined)).toBeNull();
  });
});
