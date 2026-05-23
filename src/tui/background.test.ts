import { describe, it, expect } from "vitest";
import { bgFromEnv } from "./background.js";

describe("bgFromEnv", () => {
  it("DAO_THEME 显式优先", () => {
    expect(bgFromEnv({ DAO_THEME: "light", COLORFGBG: "15;0" })).toBe("light");
    expect(bgFromEnv({ DAO_THEME: "dark", COLORFGBG: "0;15" })).toBe("dark");
  });
  it("COLORFGBG 末位:15/7 → light;0 → dark", () => {
    expect(bgFromEnv({ COLORFGBG: "0;15" })).toBe("light");
    expect(bgFromEnv({ COLORFGBG: "0;7" })).toBe("light");
    expect(bgFromEnv({ COLORFGBG: "15;0" })).toBe("dark");
  });
  it("无线索 → undefined(交给 OSC/默认)", () => {
    expect(bgFromEnv({})).toBeUndefined();
  });
});
