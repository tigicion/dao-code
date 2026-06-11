import { describe, it, expect } from "vitest";
import { withFileLock } from "./file_lock.js";

describe("withFileLock — 按路径串行", () => {
  it("同 key 串行,不交错(并行编同一文件的根治)", async () => {
    const order: string[] = [];
    const job = (tag: string, ms: number) =>
      withFileLock("a", async () => {
        order.push(`${tag}-start`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`${tag}-end`);
      });
    await Promise.all([job("1", 20), job("2", 0)]);
    expect(order).toEqual(["1-start", "1-end", "2-start", "2-end"]);
  });

  it("不同 key 可并行", async () => {
    const order: string[] = [];
    const job = (key: string, tag: string, ms: number) =>
      withFileLock(key, async () => {
        order.push(`${tag}-start`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`${tag}-end`);
      });
    await Promise.all([job("a", "1", 20), job("b", "2", 0)]);
    expect(order.indexOf("2-end")).toBeLessThan(order.indexOf("1-end")); // 2 不必等 1
  });

  it("前一个抛错不阻塞后一个", async () => {
    await withFileLock("k", async () => { throw new Error("boom"); }).catch(() => {});
    expect(await withFileLock("k", async () => 42)).toBe(42);
  });

  it("透传返回值与异常", async () => {
    expect(await withFileLock("r", async () => "ok")).toBe("ok");
    await expect(withFileLock("r", async () => { throw new Error("x"); })).rejects.toThrow("x");
  });
});
