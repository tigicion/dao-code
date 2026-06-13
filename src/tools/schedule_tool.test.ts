import { describe, it, expect } from "vitest";
import { scheduleTool } from "./schedule_tool.js";

const ctx = { workspaceRoot: "/tmp" };

describe("schedule tool", () => {
  it("声明 exec 能力 + 需审批(写 crontab 有副作用)", () => {
    expect(scheduleTool.capability).toBe("exec");
    expect(scheduleTool.approval).toBe("required");
  });
  it("add 缺 cron/prompt → 提示,不触碰 crontab", async () => {
    expect(await scheduleTool.handler({ action: "add" }, ctx)).toContain("需要 cron");
    expect(await scheduleTool.handler({ action: "add", cron: "0 9 * * *" }, ctx)).toContain("需要 cron");
  });
  it("remove 缺 index → 提示", async () => {
    expect(await scheduleTool.handler({ action: "remove" }, ctx)).toContain("需要 index");
  });
});
