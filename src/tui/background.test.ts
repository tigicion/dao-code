import { describe, it, expect } from "vitest";
import { bgFromEnv, resolveBackground, detectBackgroundAppleTerminal } from "./background.js";

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
  it("无线索 → undefined(交给 OSC/AppleScript/默认)", () => {
    expect(bgFromEnv({})).toBeUndefined();
  });
});

describe("resolveBackground 优先级", () => {
  // 非 TTY:detectBackgroundOSC 立即返回 undefined,无需 mock 终端,可稳定断言 env 分支。
  it("DAO_THEME env 最高优先(压过一切)", async () => {
    await expect(resolveBackground({ DAO_THEME: "light" })).resolves.toBe("light");
    await expect(resolveBackground({ DAO_THEME: "dark", COLORFGBG: "0;15" })).resolves.toBe("dark");
  });
  it("COLORFGBG 次之", async () => {
    await expect(resolveBackground({ COLORFGBG: "0;15" })).resolves.toBe("light");
  });
});

describe("detectBackgroundAppleTerminal", () => {
  it("非 Apple Terminal:直接 undefined(不起 osascript 进程)", async () => {
    await expect(detectBackgroundAppleTerminal({ TERM_PROGRAM: "iTerm.app" })).resolves.toBeUndefined();
    await expect(detectBackgroundAppleTerminal({})).resolves.toBeUndefined();
  });
});
