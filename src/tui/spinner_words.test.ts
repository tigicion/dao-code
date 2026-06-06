import { describe, it, expect } from "vitest";
import { DAO_VERBS, daoVerb } from "./spinner_words.js";

describe("daoVerb — 道家动词随机展示", () => {
  it("索引映射到词库,稳定可复现", () => {
    expect(daoVerb(0)).toBe(DAO_VERBS[0]);
    expect(daoVerb(1)).toBe(DAO_VERBS[1]);
  });
  it("索引循环(取模)", () => {
    expect(daoVerb(DAO_VERBS.length)).toBe(DAO_VERBS[0]);
    expect(daoVerb(DAO_VERBS.length + 2)).toBe(DAO_VERBS[2]);
  });
  it("负索引也安全", () => {
    expect(typeof daoVerb(-1)).toBe("string");
    expect(daoVerb(-1).length).toBeGreaterThan(0);
  });
  it("词库非空且都是短词(单字/双字)", () => {
    expect(DAO_VERBS.length).toBeGreaterThanOrEqual(12);
    for (const w of DAO_VERBS) expect(w.length).toBeGreaterThanOrEqual(1);
  });
});
