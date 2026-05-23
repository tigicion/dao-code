import { describe, it, expect } from "vitest";
import { buildWelcome, type WelcomeInfo } from "./banner.js";
import type { Capabilities } from "./capabilities.js";

const info: WelcomeInfo = {
  model: "deepseek-v4-pro",
  thinking: "max",
  mode: "normal",
  memories: 4,
  cwd: "/Users/x/code/codeds",
  version: "0.1.0",
};
const caps = (tier: Capabilities["tier"]): Capabilities => ({ tier, isTTY: true, columns: 80 });
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("buildWelcome", () => {
  it("含品牌、模型、模式、版本、提示", () => {
    const out = strip(buildWelcome(info, caps("truecolor"), () => 0));
    expect(out).toContain("DAO CODE");
    expect(out).toContain("道");
    expect(out).toContain("deepseek-v4-pro");
    expect(out).toContain("normal");
    expect(out).toContain("0.1.0");
    expect(out).toContain("/help");
    expect(out).toContain("Esc");
  });
  it("注入 rng=0:含名句库第一条文本", () => {
    const out = strip(buildWelcome(info, caps("none"), () => 0));
    expect(out).toContain("道可道，非常道");
  });
  it("none 档:整体无 ANSI 转义", () => {
    const out = buildWelcome(info, caps("none"), () => 0);
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out)).toBe(false);
  });
  it("truecolor 档:含真彩转义(词标渐变)", () => {
    const out = buildWelcome(info, caps("truecolor"), () => 0);
    expect(out).toContain("\x1b[38;2;");
  });
});
