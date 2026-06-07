import { describe, it, expect } from "vitest";
import { renderTaiji, TAIJI_WIDTH, detectBackground } from "./taiji.js";
import type { Capabilities } from "./capabilities.js";

const caps = (tier: Capabilities["tier"]): Capabilities => ({ tier, isTTY: true, columns: 80 });
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("renderTaiji", () => {
  it("truecolor:多行、含前景与背景真彩转义(双色阴阳鱼)", () => {
    const lines = renderTaiji(caps("truecolor"), "dark");
    expect(lines.length).toBeGreaterThan(6);
    const joined = lines.join("\n");
    expect(joined).toContain("\x1b[38;2;"); // 前景
    expect(joined).toContain("\x1b[48;2;"); // 背景(半块下像素)
  });
  it("浅/暗背景产出不同(配色自适应)", () => {
    const dark = renderTaiji(caps("truecolor"), "dark").join("\n");
    const light = renderTaiji(caps("truecolor"), "light").join("\n");
    expect(dark).not.toBe(light);
  });
  it("ansi256:用 256 色前/背景", () => {
    const joined = renderTaiji(caps("ansi256"), "dark").join("\n");
    expect(joined).toContain("\x1b[38;5;");
    expect(joined).toContain("\x1b[48;5;");
  });
  it("none/ansi16:简图退化,无 ANSI", () => {
    for (const t of ["none", "ansi16"] as const) {
      const joined = renderTaiji(caps(t)).join("\n");
      // eslint-disable-next-line no-control-regex
      expect(/\x1b\[/.test(joined)).toBe(false);
    }
  });
  it("TAIJI_WIDTH 与去色后实际最大行宽一致", () => {
    for (const t of ["truecolor", "none"] as const) {
      const lines = renderTaiji(caps(t));
      const maxVisible = Math.max(...lines.map((l) => [...strip(l)].length));
      expect(TAIJI_WIDTH(caps(t))).toBe(maxVisible);
    }
  });
});

describe("detectBackground", () => {
  it("DAO_THEME 显式优先", () => {
    expect(detectBackground({ DAO_THEME: "light", COLORFGBG: "15;0" })).toBe("light");
    expect(detectBackground({ DAO_THEME: "dark", COLORFGBG: "0;15" })).toBe("dark");
  });
  it("COLORFGBG 末位:15/7 → light;0 → dark", () => {
    expect(detectBackground({ COLORFGBG: "0;15" })).toBe("light");
    expect(detectBackground({ COLORFGBG: "0;7" })).toBe("light");
    expect(detectBackground({ COLORFGBG: "15;0" })).toBe("dark");
  });
  it("缺省 → dark", () => {
    expect(detectBackground({})).toBe("dark");
  });
});
