import { describe, it, expect } from "vitest";
import { tail } from "./App.js";

describe("tail(软换行感知的动态区限高)", () => {
  it("全部放得下:原样返回", () => {
    expect(tail("a\nb\nc", 5, 80)).toBe("a\nb\nc");
  });

  it("逻辑行数超上限:从末尾保留 n 行,行首补 …", () => {
    expect(tail("a\nb\nc\nd", 2, 80)).toBe("…\nc\nd");
  });

  it("单条长行软换行成多视觉行:按列宽折算,超限即截断", () => {
    // cols=10:每行 "0123456789"(宽10)占 1 视觉行;"01234567890"(宽11)占 2 视觉行。
    const longLine = "0".repeat(25); // 宽 25,cols=10 → ceil(25/10)=3 视觉行
    // 上限 2 视觉行,而这一条就占 3 行 → 放不下,但 while 会在 i 停在该行前,返回带 … 的它自己
    const out = tail(longLine, 2, 10);
    expect(out.startsWith("…\n")).toBe(true);
  });

  it("窄终端下:两条各占 2 视觉行的行,上限 3 → 只留末一条", () => {
    const a = "aaaaaaaaaaaa"; // 宽12,cols=10 → 2 视觉行
    const b = "bbbbbbbbbbbb"; // 宽12,cols=10 → 2 视觉行
    // 从末尾:b 占 2(≤3 保留)→ 再加 a 变 4(>3 停)→ 只留 b
    expect(tail(`${a}\n${b}`, 3, 10)).toBe(`…\n${b}`);
  });

  it("宽终端下同样的输入不折行:两条都留得下", () => {
    const a = "aaaaaaaaaaaa";
    const b = "bbbbbbbbbbbb";
    expect(tail(`${a}\n${b}`, 3, 80)).toBe(`${a}\n${b}`);
  });

  it("CJK 全角按 2 列计宽", () => {
    // "道道道道道" 宽=10,cols=10 → 1 视觉行;两条 → 2 视觉行,上限 2 → 都留
    const line = "道".repeat(5);
    expect(tail(`${line}\n${line}`, 2, 10)).toBe(`${line}\n${line}`);
    // 上限 1 → 只留末一条
    expect(tail(`${line}\n${line}`, 1, 10)).toBe(`…\n${line}`);
  });
});
