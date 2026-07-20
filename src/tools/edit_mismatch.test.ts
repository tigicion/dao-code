import { describe, it, expect } from "vitest";
import { diagnoseMismatch } from "./edit_mismatch.js";

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
