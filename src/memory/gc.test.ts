import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { daysBetween, retention, shouldPrune, gcMemories } from "./gc.js";
import { newMemory } from "./types.js";
import { writeMemory } from "./store.js";
import type { Memory } from "./types.js";

const TODAY = "2026-06-07";

function mem(p: Partial<Memory> & { name: string }): Memory {
  const base = newMemory({ name: p.name, text: p.text ?? `text-${p.name}`, type: p.type ?? "semantic", today: TODAY });
  return { ...base, ...p };
}

describe("daysBetween", () => {
  it("非负整天差", () => {
    expect(daysBetween("2026-06-01", "2026-06-07")).toBe(6);
    expect(daysBetween("2026-06-07", "2026-06-01")).toBe(6);
    expect(daysBetween("2026-06-07", "2026-06-07")).toBe(0);
  });
  it("解析失败返回 0", () => {
    expect(daysBetween("garbage", "2026-06-07")).toBe(0);
    expect(daysBetween("2026-06-07", "")).toBe(0);
  });
});

describe("retention", () => {
  it("时间越久留存越低(单调)", () => {
    const m = mem({ name: "a", uses: 0 });
    const r0 = retention({ ...m, lastUsed: "2026-06-07" }, TODAY);
    const r30 = retention({ ...m, lastUsed: "2026-05-08" }, TODAY);
    const r90 = retention({ ...m, lastUsed: "2026-03-09" }, TODAY);
    expect(r0).toBeGreaterThan(r30);
    expect(r30).toBeGreaterThan(r90);
    expect(r0).toBeCloseTo(1, 5);
  });
  it("uses 越高留存越高(强化)", () => {
    const old = "2026-03-09";
    const low = retention(mem({ name: "a", uses: 0, lastUsed: old }), TODAY);
    const high = retention(mem({ name: "a", uses: 5, lastUsed: old }), TODAY);
    expect(high).toBeGreaterThan(low);
  });
  it("一次见过的低重要度事实约 54 天后跌破 0.3", () => {
    const at56 = retention(mem({ name: "a", uses: 0, lastUsed: "2026-04-12" }), TODAY); // 56 天
    expect(at56).toBeLessThan(0.3);
    const at40 = retention(mem({ name: "a", uses: 0, lastUsed: "2026-04-28" }), TODAY); // 40 天
    expect(at40).toBeGreaterThan(0.3);
  });
});

describe("shouldPrune", () => {
  const STALE = "2026-04-12"; // 56 天前 → retention < 0.3

  it("低重要度陈旧事实被剪", () => {
    expect(shouldPrune(mem({ name: "a", importance: 3, type: "semantic", lastUsed: STALE }), TODAY)).toBe(true);
  });
  it("user 模型不剪", () => {
    expect(shouldPrune(mem({ name: "a", importance: 3, type: "user", lastUsed: STALE }), TODAY)).toBe(false);
  });
  it("feedback 不剪", () => {
    expect(shouldPrune(mem({ name: "a", importance: 3, type: "feedback", lastUsed: STALE }), TODAY)).toBe(false);
  });
  it("locked 不剪", () => {
    expect(shouldPrune(mem({ name: "a", importance: 3, type: "semantic", lastUsed: STALE, locked: true }), TODAY)).toBe(false);
  });
  it("importance≥6 不剪", () => {
    expect(shouldPrune(mem({ name: "a", importance: 6, type: "semantic", lastUsed: STALE }), TODAY)).toBe(false);
  });
  it("高 uses(频繁重确认)不剪", () => {
    expect(shouldPrune(mem({ name: "a", importance: 3, type: "semantic", lastUsed: STALE, uses: 10 }), TODAY)).toBe(false);
  });
  it("低置信、从未被召回、低重要度的 user 推断 → 不再受保护,陈旧后被剪", () => {
    const m = mem({ name: "a", type: "user", importance: 5, confidence: 0.4, uses: 0, lastUsed: STALE });
    expect(shouldPrune(m, TODAY)).toBe(true);
  });
  it("低置信 user 推断但仍新鲜(未陈旧)不剪", () => {
    const m = mem({ name: "a", type: "user", importance: 5, confidence: 0.4, uses: 0, lastUsed: TODAY });
    expect(shouldPrune(m, TODAY)).toBe(false);
  });
  it("被召回过(uses>0)的 user 记忆仍受保护", () => {
    const m = mem({ name: "a", type: "user", importance: 5, confidence: 0.4, uses: 1, lastUsed: STALE });
    expect(shouldPrune(m, TODAY)).toBe(false);
  });
  it("高置信 user 事实仍受保护", () => {
    const m = mem({ name: "a", type: "user", importance: 5, confidence: 0.9, uses: 0, lastUsed: STALE });
    expect(shouldPrune(m, TODAY)).toBe(false);
  });
  it("过期+宽限期已过的 superseded 被剪", () => {
    const m = mem({ name: "a", importance: 9, type: "semantic", status: "superseded", validUntil: "2026-05-20", lastUsed: TODAY });
    expect(shouldPrune(m, TODAY)).toBe(true); // 05-20 + 7 = 05-27 < 06-07
  });
  it("过期但仍在宽限期内不剪", () => {
    const m = mem({ name: "a", importance: 9, type: "semantic", status: "superseded", validUntil: "2026-06-03", lastUsed: TODAY });
    expect(shouldPrune(m, TODAY)).toBe(false); // 06-03 + 7 = 06-10 > 06-07
  });
});

describe("gcMemories", () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "gc-")); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it("缺失目录返回 []", async () => {
    expect(await gcMemories(path.join(dir, "nope"), TODAY)).toEqual([]);
  });

  it("剪掉死记忆,保留活记忆", async () => {
    await writeMemory(dir, mem({ name: "dead", importance: 2, type: "semantic", lastUsed: "2026-04-12" }));
    await writeMemory(dir, mem({ name: "alive", importance: 8, type: "semantic", lastUsed: "2026-04-12" }));
    const pruned = await gcMemories(dir, TODAY);
    expect(pruned).toEqual(["dead"]);
    const left = await fs.readdir(dir);
    expect(left).toContain("alive.md");
    expect(left).not.toContain("dead.md");
  });
});
