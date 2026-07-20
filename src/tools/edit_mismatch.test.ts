import { describe, it, expect } from "vitest";
import { diagnoseMismatch, findActualString } from "./edit_mismatch.js";

describe("findActualString", () => {
  it("精确匹配命中时直接返回搜索串", () => {
    expect(findActualString("hello world", "world")).toBe("world");
  });

  it("全角冒号 vs 半角冒号:返回文件里的真实文本", () => {
    const file = "auto: enabled";
    const search = "auto: enabled"; // U+FF1A vs U+003A
    const result = findActualString(file, search);
    expect(result).toBe("auto: enabled"); // 返回文件里的全角冒号版本
  });

  it("弯引号 vs 直引号:返回文件里的真实文本", () => {
    const file = 'const s = "hello";'; // 弯引号
    const search = 'const s = "hello";'; // 直引号
    const result = findActualString(file, search);
    expect(result).toBe('const s = "hello";');
  });

  it("全角逗号 vs 半角逗号:返回文件里的真实文本", () => {
    const file = "do A, then B"; // 全角逗号
    const search = "do A, then B"; // 半角逗号
    const result = findActualString(file, search);
    expect(result).toBe("do A, then B");
  });

  it("多种标点同时写岔:全部归一化", () => {
    const file = "auto: enabled, done."; // 全角冒号+全角逗号+全角句号
    const search = "auto: enabled, done."; // 全半角
    const result = findActualString(file, search);
    expect(result).toBe("auto: enabled, done.");
  });

  it("完全找不到时返回 null", () => {
    expect(findActualString("hello world", "goodbye")).toBeNull();
  });

  it("空搜索串返回 null", () => {
    expect(findActualString("anything", "")).toBeNull();
  });

  it("超长搜索串跳过归一化,精确匹配仍生效", () => {
    const long = "x".repeat(6000);
    expect(findActualString(long, long)).toBe(long);
    expect(findActualString("y".repeat(6000), long)).toBeNull();
  });

  it("归一化匹配到的文本长度与搜索串一致", () => {
    const file = "auto: enabled";
    const search = "auto: enabled";
    const result = findActualString(file, search);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(search.length);
  });
});

describe("diagnoseMismatch", () => {
  it("识别 em dash 被写成 ASCII 双连字符", () => {
    const raw = "免一次审批——\n  // Bash 走 AST";
    const old = "免一次审批--";
    const hint = diagnoseMismatch(raw, old);
    expect(hint).toContain("U+002D");
    expect(hint).toContain("U+2014");
    expect(hint).toMatch(/第 6 个字符/);
  });

  it("识别弯引号被写成直引号", () => {
    const raw = 'const s = "hello";';
    const old = "const s = “hello”;";
    const hint = diagnoseMismatch(raw, old);
    expect(hint).not.toBeNull();
    expect(hint).toContain("U+201C"); // “
  });

  it("识别全角逗号/句号被写成半角", () => {
    const raw = "先做 A,再做 B。";
    const old = "先做 A，再做 B.";
    const hint = diagnoseMismatch(raw, old);
    expect(hint).not.toBeNull();
  });

  it("内容真的不同(非形近标点)时返回 null", () => {
    const raw = "function foo() { return 1; }";
    const old = "function bar() { return 2; }";
    expect(diagnoseMismatch(raw, old)).toBeNull();
  });

  it("old_string 与文件完全一致时返回 null(不该在这种情形下给出诊断)", () => {
    const raw = "hello world";
    const old = "hello world";
    expect(diagnoseMismatch(raw, old)).toBeNull();
  });

  it("空 old_string 返回 null", () => {
    expect(diagnoseMismatch("anything", "")).toBeNull();
  });

  it("超长 old_string 直接跳过诊断", () => {
    const old = "x".repeat(6000);
    expect(diagnoseMismatch("y".repeat(6000), old)).toBeNull();
  });
});
