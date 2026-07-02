import { describe, it, expect, beforeEach } from "vitest";
import { setBackend, getBackend, isObsOn } from "./backend.js";
import type { ObsBackend } from "./backend.js";

const fake: ObsBackend = {
  startSpan: () => ({ setAttributes() {}, end() {} }),
  withActive: (_s, fn) => fn(),
  flush: async () => {},
};

describe("backend 单例", () => {
  beforeEach(() => setBackend(null));
  it("默认关闭:getBackend null、isObsOn false", () => {
    expect(getBackend()).toBeNull();
    expect(isObsOn()).toBe(false);
  });
  it("setBackend 后开启", () => {
    setBackend(fake);
    expect(getBackend()).toBe(fake);
    expect(isObsOn()).toBe(true);
  });
});
