import { describe, it, expect } from "vitest";
import { paint, gradientBlock } from "./theme.js";
import type { Capabilities } from "./capabilities.js";

const caps = (tier: Capabilities["tier"]): Capabilities => ({ tier, isTTY: true, columns: 80 });

describe("paint", () => {
  it("none 档:原样返回,无 ANSI", () => {
    const out = paint("道", "jade", caps("none"));
    expect(out).toBe("道");
     
    expect(/\x1b\[/.test(out)).toBe(false);
  });
  it("truecolor 档:含 38;2;r;g;b 前景", () => {
    const out = paint("道", "jade", caps("truecolor"));
    expect(out).toContain("\x1b[38;2;");
    expect(out).toContain("道");
    expect(out.endsWith("\x1b[39m")).toBe(true);
  });
  it("ansi256 档:含 38;5;N", () => {
    expect(paint("道", "jade", caps("ansi256"))).toContain("\x1b[38;5;");
  });
  it("ansi16 档:含基础 SGR(30-37 或 90-97)", () => {
    const out = paint("道", "vermilion", caps("ansi16"));
    expect(/\x1b\[(3[0-7]|9[0-7])m/.test(out)).toBe(true);
  });
});

describe("gradientBlock", () => {
  it("truecolor:每行被真彩转义包裹", () => {
    const lines = gradientBlock(["AAAA", "BBBB"], "jade", "ink", caps("truecolor"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("\x1b[38;2;");
  });
  it("none:原样无 ANSI", () => {
    const lines = gradientBlock(["AAAA"], "jade", "ink", caps("none"));
    expect(lines[0]).toBe("AAAA");
  });
  it("非 truecolor(ansi256):退化为单色 jade,不做逐字渐变", () => {
    const lines = gradientBlock(["AAAA"], "jade", "ink", caps("ansi256"));
    expect(lines[0]).toContain("\x1b[38;5;");
  });
});
