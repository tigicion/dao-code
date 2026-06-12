import { describe, it, expect } from "vitest";
import { buildCronLine } from "./schedule.js";

describe("buildCronLine", () => {
  it("拼出带 cd + headless dao + 日志 + 标记的 crontab 行", () => {
    const l = buildCronLine("0 9 * * *", "检查 PR", "/proj/x", "/usr/bin/dao");
    expect(l.startsWith("0 9 * * * ")).toBe(true);
    expect(l).toContain("cd '/proj/x'");
    expect(l).toContain("'/usr/bin/dao' '检查 PR'");
    expect(l).toContain("schedule.log");
    expect(l).toContain("# dao-schedule");
  });
  it("单引号被安全转义", () => {
    const l = buildCronLine("* * * * *", "it's a test", "/a", "/dao");
    expect(l).toContain(`'it'\\''s a test'`);
  });
});
