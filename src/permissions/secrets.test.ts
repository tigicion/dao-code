import { describe, it, expect } from "vitest";
import { findSecrets, redactSecrets } from "./secrets.js";

describe("findSecrets", () => {
  it("detects common key shapes", () => {
    expect(findSecrets("AKIA1234567890ABCDEF").length).toBeGreaterThan(0);
    expect(findSecrets("-----BEGIN OPENSSH PRIVATE KEY-----").length).toBeGreaterThan(0);
    expect(findSecrets("token = \"abcdefgh12345678\"").length).toBeGreaterThan(0);
    expect(findSecrets("ghp_" + "a".repeat(36)).length).toBeGreaterThan(0);
    expect(findSecrets("use the " + "sk-" + "a".repeat(30) + " key").length).toBeGreaterThan(0);
  });
  it("does not flag ordinary prose/code", () => {
    expect(findSecrets("the api returns a json object")).toEqual([]);
    expect(findSecrets("用户偏好 TypeScript,喜欢简洁实现")).toEqual([]);
    expect(findSecrets("const x = 1; // a short token")).toEqual([]);
  });
  it("redacts matches", () => {
    const r = redactSecrets("key AKIA1234567890ABCDEF here");
    expect(r).not.toContain("AKIA1234567890ABCDEF");
    expect(r).toContain("已隐去");
  });
});
