import { describe, it, expect } from "vitest";
import { buildMemorySection, selectForInjection, selectFullText, selectIndexNames, buildIndexSection } from "./inject.js";
import { newMemory } from "./types.js";
import type { Memory } from "./types.js";

describe("buildMemorySection", () => {
  it("drops stale, annotates changed, keeps ok", () => {
    const a = newMemory({ name: "a", text: "事实A", type: "semantic", today: "2026-06-07" });
    const b = newMemory({ name: "b", text: "事实B", type: "semantic", today: "2026-06-07" });
    const c = newMemory({ name: "c", text: "事实C", type: "semantic", today: "2026-06-07" });
    const text = buildMemorySection([
      { mem: a, verdict: "ok" },
      { mem: b, verdict: "changed" },
      { mem: c, verdict: "stale" },
    ]);
    expect(text).toContain("事实A");
    expect(text).toContain("事实B(可能已过期");
    expect(text).not.toContain("事实C");
  });

  it("returns empty string when all stale", () => {
    const c = newMemory({ name: "c", text: "事实C", type: "semantic", today: "2026-06-07" });
    expect(buildMemorySection([{ mem: c, verdict: "stale" }])).toBe("");
  });
});

describe("selectForInjection", () => {
  const TODAY = "2026-06-07";
  function mk(p: Partial<Memory> & { name: string }): Memory {
    const base = newMemory({ name: p.name, text: p.text ?? `t-${p.name}`, type: p.type ?? "semantic", today: TODAY });
    return { ...base, ...p };
  }

  it("under cap → 全部保留(剔除 stale),保序", () => {
    const items = [
      { mem: mk({ name: "a" }), verdict: "ok" as const },
      { mem: mk({ name: "b" }), verdict: "stale" as const },
      { mem: mk({ name: "c" }), verdict: "changed" as const },
    ];
    const out = selectForInjection(items, TODAY, 150);
    expect(out.map((x) => x.mem.name)).toEqual(["a", "c"]);
  });

  it("over cap → user 必留 + 总数 ≤ cap + 最高重要度保留 + 低重要度旧事实被弃", () => {
    const items: { mem: Memory; verdict: "ok" }[] = [];
    // 5 条 user 模型
    for (let i = 0; i < 5; i++) items.push({ mem: mk({ name: `user-${i}`, type: "user", importance: 1 }), verdict: "ok" });
    // 1 条高重要度
    items.push({ mem: mk({ name: "vip", type: "semantic", importance: 10, lastUsed: TODAY }), verdict: "ok" });
    // 1 条低重要度且很旧 → 应被弃
    items.push({ mem: mk({ name: "junk", type: "semantic", importance: 1, lastUsed: "2025-01-01" }), verdict: "ok" });
    // 填充噪声
    for (let i = 0; i < 50; i++) items.push({ mem: mk({ name: `n-${i}`, type: "semantic", importance: 5, lastUsed: TODAY }), verdict: "ok" });

    const cap = 10;
    const out = selectForInjection(items, TODAY, cap);
    const names = out.map((x) => x.mem.name);
    expect(out.length).toBeLessThanOrEqual(cap);
    for (let i = 0; i < 5; i++) expect(names).toContain(`user-${i}`);
    expect(names).toContain("vip");
    expect(names).not.toContain("junk");
  });

  it("over cap → feedback 与 user 同等必留", () => {
    const items: { mem: Memory; verdict: "ok" }[] = [];
    items.push({ mem: mk({ name: "fb", type: "feedback", importance: 1, lastUsed: "2025-01-01" }), verdict: "ok" });
    for (let i = 0; i < 50; i++) items.push({ mem: mk({ name: `n-${i}`, type: "semantic", importance: 9, lastUsed: TODAY }), verdict: "ok" });
    const out = selectForInjection(items, TODAY, 10);
    expect(out.map((x) => x.mem.name)).toContain("fb");
  });

  it("over cap 时 stale 不计数也不注入", () => {
    const items: { mem: Memory; verdict: "ok" | "stale" }[] = [];
    for (let i = 0; i < 200; i++) items.push({ mem: mk({ name: `s-${i}` }), verdict: "stale" });
    items.push({ mem: mk({ name: "live", importance: 9, lastUsed: TODAY }), verdict: "ok" });
    const out = selectForInjection(items, TODAY, 150);
    expect(out.map((x) => x.mem.name)).toEqual(["live"]);
  });
});

describe("两层读取(selectFullText / selectIndexNames / buildIndexSection)", () => {
  const TODAY = "2026-06-07";
  function mk(p: Partial<Memory> & { name: string }): Memory {
    const base = newMemory({ name: p.name, text: p.text ?? `t-${p.name}`, type: p.type ?? "semantic", today: TODAY });
    return { ...base, ...p };
  }

  it("selectFullText:user/feedback/locked 必入全文,其余按留存取 top 至 fullCap", () => {
    const items: { mem: Memory; verdict: "ok" }[] = [
      { mem: mk({ name: "u", type: "user", importance: 1 }), verdict: "ok" },
      { mem: mk({ name: "fb", type: "feedback", importance: 1 }), verdict: "ok" },
      { mem: mk({ name: "lk", type: "semantic", importance: 1, locked: true }), verdict: "ok" },
      { mem: mk({ name: "hi", type: "semantic", importance: 9, lastUsed: TODAY }), verdict: "ok" },
      { mem: mk({ name: "lo", type: "semantic", importance: 2, lastUsed: "2025-01-01" }), verdict: "ok" },
    ];
    const full = selectFullText(items, TODAY, 4).map((x) => x.mem.name);
    expect(full).toContain("u");
    expect(full).toContain("fb");
    expect(full).toContain("lk");
    expect(full).toContain("hi"); // 高重要度近期 → 占掉剩余名额
    expect(full).not.toContain("lo"); // 低重要度旧 → 挤出
    expect(full.length).toBeLessThanOrEqual(4);
  });

  it("selectFullText 剔除 stale", () => {
    const items = [
      { mem: mk({ name: "a", type: "user" }), verdict: "ok" as const },
      { mem: mk({ name: "b", type: "user" }), verdict: "stale" as const },
    ];
    expect(selectFullText(items, TODAY).map((x) => x.mem.name)).toEqual(["a"]);
  });

  it("selectIndexNames:只给全文集【之外】的 live 记忆名,按留存排序、封顶、剔 stale", () => {
    const items: { mem: Memory; verdict: "ok" | "stale" }[] = [
      { mem: mk({ name: "u", type: "user" }), verdict: "ok" },
      { mem: mk({ name: "x", type: "semantic", importance: 9, lastUsed: TODAY }), verdict: "ok" },
      { mem: mk({ name: "y", type: "semantic", importance: 3, lastUsed: TODAY }), verdict: "ok" },
      { mem: mk({ name: "z", type: "semantic" }), verdict: "stale" },
    ];
    const full = selectFullText(items, TODAY, 1); // 只 user 进全文
    const idx = selectIndexNames(items, TODAY, full, 200);
    expect(idx).not.toContain("u"); // 已在全文,不重复进索引
    expect(idx).not.toContain("z"); // stale 排除
    expect(idx).toEqual(["x", "y"]); // 按留存降序
  });

  it("selectIndexNames 封顶 indexCap", () => {
    const items: { mem: Memory; verdict: "ok" }[] = [];
    for (let i = 0; i < 50; i++) items.push({ mem: mk({ name: `n-${i}`, importance: 5, lastUsed: TODAY }), verdict: "ok" });
    expect(selectIndexNames(items, TODAY, [], 10).length).toBe(10);
  });

  it("buildIndexSection:列名 + 用法提示;空则空串", () => {
    expect(buildIndexSection([])).toBe("");
    const s = buildIndexSection(["foo", "bar"]);
    expect(s).toContain("memory_read");
    expect(s).toContain("- foo");
    expect(s).toContain("- bar");
    expect(s).toContain("其余 2 条");
  });
});
