import { describe, it, expect } from "vitest";
import { notify } from "./notifier.js";

type Call = { cmd: string; args: string[] };

function fakeExec(onCall?: (call: Call, cb: (err: Error | null) => void) => void) {
  const calls: Call[] = [];
  const exec = ((cmd: string, args: string[], cb: (err: Error | null) => void) => {
    const call = { cmd, args };
    calls.push(call);
    if (onCall) onCall(call, cb);
    else cb(null);
  }) as unknown as typeof import("node:child_process").execFile;
  return { exec, calls };
}

describe("notify", () => {
  it("DAO_NO_NOTIFY=1 → 完全不调用任何命令", () => {
    const { exec, calls } = fakeExec();
    notify("t", "m", { exec, env: { DAO_NO_NOTIFY: "1" }, platform: "darwin" });
    expect(calls.length).toBe(0);
  });

  it("darwin + 已知 TERM_PROGRAM → 优先用 terminal-notifier 并带 -activate 精确聚焦", () => {
    const { exec, calls } = fakeExec();
    notify("t", "m", { exec, env: { TERM_PROGRAM: "Apple_Terminal" }, platform: "darwin" });
    expect(calls.length).toBe(1);
    expect(calls[0]!.cmd).toBe("terminal-notifier");
    expect(calls[0]!.args).toEqual(["-title", "t", "-message", "m", "-activate", "com.apple.Terminal"]);
  });

  it("darwin + terminal-notifier 未安装(exec 报错)→ 退回裸 osascript,仍能弹通知", () => {
    // 曾经想给这条退回路径加 `tell application id X to display notification`,指望让通知
    // "看起来"归属到目标终端、点击时聚焦过去——查过 Apple 官方 Mac Automation Scripting Guide
    // 证实这个包装不生效:通知的归属只跟"实际执行这段 AppleScript 的进程"有关(这里始终是
    // osascript),跟 tell 的目标完全无关,包一层没有任何效果,已经撤回。这条路径就是老实弹个
    // 通知,不承诺点击行为。
    const { exec, calls } = fakeExec((call, cb) => {
      if (call.cmd === "terminal-notifier") cb(new Error("ENOENT"));
      else cb(null);
    });
    notify("t", "m", { exec, env: { TERM_PROGRAM: "Apple_Terminal" }, platform: "darwin" });
    expect(calls.map((c) => c.cmd)).toEqual(["terminal-notifier", "osascript"]);
    expect(calls[1]!.args[0]).toBe("-e");
    expect(calls[1]!.args[1]).toContain("display notification");
    expect(calls[1]!.args[1]).not.toContain("tell application");
  });

  it("darwin + 未知/缺失 TERM_PROGRAM → 直接走 osascript,不尝试 terminal-notifier", () => {
    const { exec, calls } = fakeExec();
    notify("t", "m", { exec, env: {}, platform: "darwin" });
    expect(calls.length).toBe(1);
    expect(calls[0]!.cmd).toBe("osascript");
  });

  it("linux → notify-send(行为不变)", () => {
    const { exec, calls } = fakeExec();
    notify("t", "m", { exec, env: {}, platform: "linux" });
    expect(calls).toEqual([{ cmd: "notify-send", args: ["t", "m"] }]);
  });

  it("win32 → 脚本含 Start-Sleep,避免进程在气泡渲染前就退出", () => {
    const { exec, calls } = fakeExec();
    notify("t", "m", { exec, env: {}, platform: "win32" });
    expect(calls.length).toBe(1);
    expect(calls[0]!.cmd).toBe("powershell");
    const script = calls[0]!.args.at(-1)!;
    expect(script).toContain("ShowBalloonTip");
    expect(script).toContain("Start-Sleep");
  });
});
