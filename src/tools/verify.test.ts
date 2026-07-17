import { describe, it, expect } from "vitest";
import { verifyDoneTool } from "./verify.js";
import type { ToolContext } from "./types.js";

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ workspaceRoot: process.cwd(), ...over });

describe("verify_done(DoD)", () => {
  it("未配置验收命令 → 提示模型自判", async () => {
    const out = await verifyDoneTool.handler({}, ctx());
    expect(out).toContain("未配置");
    expect(out).toContain("自判");
  });
  it("未配置验收命令 → 提示同时检查任务原文里的结构性/格式性要求(不止是'跑起来对不对')", async () => {
    // 根因(内省复盘 build-pmars 时发现):模型只验证了自己记得的几条(能跑、无X11依赖),
    // 漏了任务原文明写但不影响"跑不跑得通"的一条(debian/目录要保留),verify_done当时
    // 只强调"验证方法"(真跑别只读代码)、完全没约束"验证范围要覆盖用户说过的每一句话"。
    const out = await verifyDoneTool.handler({}, ctx());
    expect(out).toContain("范围也要对");
    expect(out).toContain("结构性/格式性要求");
  });
  it("未配置验收命令 → 提示'发现可疑线索不能自行合理化跳过,要查到底再重新调用本工具核实'", async () => {
    // 根因(build-pmars复测第二轮发现):模型这次确实响应了'范围也要对'的提示、去调查了
    // debian/src目录结构,已经推理到了正确答案边缘(定位到debian/rules里的sourcedir提示),
    // 但说了一句"that doesn't matter for our purposes"就自己合理化掉了这条线索,写了个
    // 不包含这条要求的总结表格收尾,全程只调用过1次verify_done、没有在发现疑点后二次核实。
    const out = await verifyDoneTool.handler({}, ctx());
    expect(out).toContain("可能没做对");
    expect(out).toContain("再调用一次本工具重新核实");
  });
  it("验收命令 exit 0 → 通过", async () => {
    const out = await verifyDoneTool.handler({}, ctx({ verifyCommand: "exit 0" }));
    expect(out).toContain("验收通过");
    expect(out).toContain("exit 0");
  });
  it("验收命令 非0 → 失败", async () => {
    const out = await verifyDoneTool.handler({}, ctx({ verifyCommand: "echo boom >&2; exit 3" }));
    expect(out).toContain("验收失败");
    expect(out).toContain("exit 3");
    expect(out).toContain("boom");
  });
});
