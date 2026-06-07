import { describe, it, expect } from "vitest";
import { randomMaxim } from "./maxim.js";
import { MAXIMS } from "../data/laozi-maxims.js";

describe("randomMaxim", () => {
  it("注入 rng=0 取第一条", () => {
    expect(randomMaxim(() => 0)).toEqual(MAXIMS[0]);
  });
  it("注入 rng≈1 取最后一条", () => {
    expect(randomMaxim(() => 0.999999)).toEqual(MAXIMS[MAXIMS.length - 1]);
  });
  it("默认无参也返回库中一条", () => {
    expect(MAXIMS).toContainEqual(randomMaxim());
  });
});
