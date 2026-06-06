import { describe, it, expect } from "vitest";
import { displayWidth, padEnd } from "./width.js";

describe("displayWidth", () => {
  it("counts ASCII as 1 and CJK as 2", () => {
    expect(displayWidth("ab")).toBe(2);
    expect(displayWidth("张三")).toBe(4);
    expect(displayWidth("a张")).toBe(3);
  });
  it("counts an empty string as 0", () => {
    expect(displayWidth("")).toBe(0);
  });
});

describe("padEnd", () => {
  it("pads CJK-aware to the target display width", () => {
    expect(padEnd("张三", 6)).toBe("张三  ");
    expect(padEnd("ab", 5)).toBe("ab   ");
  });
  it("leaves strings already at/over width unchanged", () => {
    expect(padEnd("张三", 4)).toBe("张三");
    expect(padEnd("abcd", 2)).toBe("abcd");
  });
});
