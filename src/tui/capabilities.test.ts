import { describe, it, expect } from "vitest";
import { detectCapabilities } from "./capabilities.js";

describe("detectCapabilities", () => {
  it("非 TTY → none", () => {
    const c = detectCapabilities({}, false);
    expect(c.tier).toBe("none");
    expect(c.isTTY).toBe(false);
  });
  it("NO_COLOR 即使 TTY 也 → none", () => {
    expect(detectCapabilities({ NO_COLOR: "1", COLORTERM: "truecolor" }, true).tier).toBe("none");
  });
  it("COLORTERM=truecolor → truecolor", () => {
    expect(detectCapabilities({ COLORTERM: "truecolor" }, true).tier).toBe("truecolor");
  });
  it("COLORTERM=24bit → truecolor", () => {
    expect(detectCapabilities({ COLORTERM: "24bit" }, true).tier).toBe("truecolor");
  });
  it("TERM 含 256color → ansi256", () => {
    expect(detectCapabilities({ TERM: "xterm-256color" }, true).tier).toBe("ansi256");
  });
  it("普通 TTY 无线索 → ansi16", () => {
    expect(detectCapabilities({ TERM: "xterm" }, true).tier).toBe("ansi16");
  });
  it("FORCE_COLOR=3 → truecolor(便于强制)", () => {
    expect(detectCapabilities({ FORCE_COLOR: "3" }, true).tier).toBe("truecolor");
  });
  it("columns 默认 80,可由 COLUMNS 覆盖", () => {
    expect(detectCapabilities({}, true).columns).toBe(80);
    expect(detectCapabilities({ COLUMNS: "120" }, true).columns).toBe(120);
    expect(detectCapabilities({}, true, 100).columns).toBe(100);
  });
});
