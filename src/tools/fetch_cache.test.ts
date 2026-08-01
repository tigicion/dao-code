import { describe, it, expect, beforeEach } from "vitest";
import { getCachedFetch, setCachedFetch, clearFetchCache, MAX_ENTRIES } from "./fetch_cache.js";

describe("fetch_cache", () => {
  beforeEach(() => clearFetchCache());

  it("returns undefined for a URL that was never cached", () => {
    expect(getCachedFetch("https://example.com")).toBeUndefined();
  });

  it("returns the cached text within the TTL window", () => {
    const now = 1_000_000;
    setCachedFetch("https://example.com", "hello world", now);
    expect(getCachedFetch("https://example.com", now + 60_000)).toBe("hello world");
  });

  it("expires entries after 15 minutes", () => {
    const now = 1_000_000;
    setCachedFetch("https://example.com", "hello world", now);
    const fifteenMinLaterPlusOne = now + 15 * 60_000 + 1;
    expect(getCachedFetch("https://example.com", fifteenMinLaterPlusOne)).toBeUndefined();
  });

  it("evicts the oldest entry once capacity is exceeded", () => {
    const now = 1_000_000;
    for (let i = 0; i < MAX_ENTRIES; i++) {
      setCachedFetch(`https://example.com/${i}`, `page ${i}`, now);
    }
    // 第一条应该还在(未超容量前)
    expect(getCachedFetch("https://example.com/0", now)).toBe("page 0");
    // 超出容量,再插一条 → 最早的一条(0)被淘汰
    setCachedFetch("https://example.com/overflow", "overflow page", now);
    expect(getCachedFetch("https://example.com/0", now)).toBeUndefined();
    expect(getCachedFetch("https://example.com/overflow", now)).toBe("overflow page");
  });
});
