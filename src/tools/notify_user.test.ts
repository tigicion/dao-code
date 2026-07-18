import { describe, it, expect } from "vitest";
import { notifyUserTool } from "./notify_user.js";

describe("NotifyUser", () => {
  it("调用 ctx.notifyUser 并确认", async () => {
    let sent: string | null = null;
    const out = await notifyUserTool.handler(
      { message: "定时任务发现一个问题,需要你尽快看看" },
      { workspaceRoot: "/w", notifyUser: (m) => { sent = m; } },
    );
    expect(sent).toBe("定时任务发现一个问题,需要你尽快看看");
    expect(out).toContain("已发送桌面通知");
  });

  it("环境不支持时 → 提示", async () => {
    const out = await notifyUserTool.handler({ message: "x" }, { workspaceRoot: "/w" });
    expect(out).toContain("不支持桌面通知");
  });
});
