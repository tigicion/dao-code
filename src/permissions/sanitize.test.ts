import { describe, it, expect } from "vitest";
import { hasSuspiciousUnicode, hasNullByte } from "./sanitize.js";

describe("hasSuspiciousUnicode", () => {
  it("flags homoglyph / zero-width / fullwidth / null-byte", () => {
    expect(hasSuspiciousUnicode("ｒｍ -rf /")).toBe(true); // 全角 rm
    expect(hasSuspiciousUnicode("rm​ -rf")).toBe(true); // 零宽空格
    expect(hasSuspiciousUnicode("a\0b")).toBe(true); // null 字节
    expect(hasSuspiciousUnicode("ls‮")).toBe(true); // RTL override
  });
  it("does not flag normal ASCII / Chinese / whitespace", () => {
    expect(hasSuspiciousUnicode("rm -rf node_modules")).toBe(false);
    expect(hasSuspiciousUnicode("cat 项目/说明.md")).toBe(false);
    expect(hasSuspiciousUnicode("echo hi\n  && ls\t-l")).toBe(false);
    expect(hasSuspiciousUnicode("")).toBe(false);
  });
});

describe("hasNullByte", () => {
  it("detects null bytes only", () => {
    expect(hasNullByte("a\0b")).toBe(true);
    expect(hasNullByte("normal/path.ts")).toBe(false);
  });
});
