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
