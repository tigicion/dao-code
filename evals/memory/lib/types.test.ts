import { describe, it, expect } from "vitest";
import { isGoldFact } from "./types.js";

describe("types 守卫", () => {
  it("isGoldFact 认结构完整的事实、拒缺字段", () => {
    expect(isGoldFact({ text: "x", type: "user", scope: "user" })).toBe(true);
    expect(isGoldFact({ text: "x", type: "user" })).toBe(false);
    expect(isGoldFact(null)).toBe(false);
  });
});
