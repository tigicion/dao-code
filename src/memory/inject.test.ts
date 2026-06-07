import { describe, it, expect } from "vitest";
import { buildMemorySection } from "./inject.js";
import { newMemory } from "./types.js";

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
