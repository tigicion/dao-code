import { describe, it, expect } from "vitest";
import { buildEditHunk } from "./diff_hunk.js";

describe("buildEditHunk — 带行号+上下文的 diff(复刻 CC)", () => {
  const raw = "import x\nfunction f() {\n  return 1\n}\n";
  it("上下文行(空格前缀)+ 删除(-)+ 新增(+),都带行号", () => {
    const rows = buildEditHunk(raw, "  return 1", "  return 2", 3);
    expect(rows.some((r) => r.startsWith(" ") && r.includes("function f() {"))).toBe(true);
    expect(rows.find((r) => r.startsWith("-"))).toMatch(/^-\s*3\s+return 1/);
    expect(rows.find((r) => r.startsWith("+"))).toMatch(/^\+\s*3\s+return 2/);
  });
  it("old_string 找不到 → 空数组", () => {
    expect(buildEditHunk(raw, "不存在", "x", 3)).toEqual([]);
  });
  it("ctx=0 时只有增删行,无上下文", () => {
    const rows = buildEditHunk(raw, "  return 1", "  return 2", 0);
    expect(rows.every((r) => r.startsWith("-") || r.startsWith("+"))).toBe(true);
  });
});
