import { describe, it, expect } from "vitest";
import { hasSuspiciousUnicode, hasNullByte, sanitizeText } from "./sanitize.js";

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

describe("sanitizeText", () => {
  it("normalizes fullwidth homoglyphs to ascii", () => {
    const r = sanitizeText("ｒｍ -rf /"); // 全角 rm
    expect(r.clean).toBe("rm -rf /");
    expect(r.suspicious).toBe(true);
  });
  it("strips zero-width / RTL override / null byte", () => {
    expect(sanitizeText("rm​ -rf").clean).toBe("rm -rf"); // 含零宽空格
    expect(sanitizeText("rm​ -rf").suspicious).toBe(true);
    expect(sanitizeText("ls‮").clean).toBe("ls");
    expect(sanitizeText("a\0b").clean).toBe("ab");
    expect(sanitizeText("a\0b").suspicious).toBe(true);
  });
  it("leaves clean text unchanged with suspicious=false", () => {
    expect(sanitizeText("rm -rf node_modules")).toEqual({ clean: "rm -rf node_modules", suspicious: false });
    expect(sanitizeText("cat 项目/说明.md")).toEqual({ clean: "cat 项目/说明.md", suspicious: false });
    expect(sanitizeText("echo hi\n  && ls\t-l")).toEqual({ clean: "echo hi\n  && ls\t-l", suspicious: false });
    expect(sanitizeText("")).toEqual({ clean: "", suspicious: false });
  });
});
