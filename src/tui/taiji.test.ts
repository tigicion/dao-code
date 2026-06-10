import { describe, it, expect } from "vitest";
import { renderTaiji, TAIJI_WIDTH } from "./taiji.js";
import type { Capabilities } from "./capabilities.js";

const caps = (tier: Capabilities["tier"]): Capabilities => ({ tier, isTTY: true, columns: 120 });
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("renderTaiji", () => {
  it("truecolor:8 行(与词标块齐平)、仅背景真彩(纯背景色渲染)", () => {
    const lines = renderTaiji(caps("truecolor"), "dark");
    expect(lines.length).toBe(8);
    const joined = lines.join("\n");
    expect(joined).toContain("\x1b[48;2;"); // 背景整格涂
    expect(joined).not.toContain("\x1b[38;2;"); // 不用前景色
  });
  it("零字形依赖:除转义外只有空格(无任何块字符)", () => {
    const lines = renderTaiji(caps("truecolor"), "light");
    const visible = lines.map(strip).join("");
    expect(visible.trim()).toBe(""); // 全部是空格,颜色来自背景
  });
  it("浅/暗背景产出不同(配色自适应)", () => {
    const dark = renderTaiji(caps("truecolor"), "dark").join("\n");
    const light = renderTaiji(caps("truecolor"), "light").join("\n");
    expect(dark).not.toBe(light);
  });
  it("ansi256:用 256 色背景", () => {
    const joined = renderTaiji(caps("ansi256"), "dark").join("\n");
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
