import { describe, it, expect } from "vitest";
import { clampOutput } from "./output.js";

describe("clampOutput", () => {
  it("短输出原样返回", () => {
    expect(clampOutput("hello", 100)).toBe("hello");
  });
  it("超长中间截断,保头+保尾,标注省略量", () => {
    const s = "A".repeat(500) + "TAILMARK";
    const out = clampOutput(s, 100);
    expect(out.length).toBeLessThan(s.length);
    expect(out.startsWith("A")).toBe(true);
    expect(out).toContain("TAILMARK"); // 尾部保留
    expect(out).toContain("已省略中间");
  });
});
