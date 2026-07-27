import { describe, it, expect } from "vitest";
import { verifyDoneTool } from "./verify.js";
import { decide } from "../permissions/engine.js";
import { emptyPermissions } from "../permissions/settings.js";
import { ASYNC_AGENT_ALLOWED_TOOLS } from "../agent/agent_tools.js";

describe("VerifyDone(完成前验证检查点)", () => {
  // 恢复动机是【行为数据】不是主观偏好:移除前 240 个 trial 里 130 个(54.2%)真的调用过
  // verify_done;移除后 107 个 trial 里只有 1 个(0.9%)派过验证子代理。提示词里一直写着
  // "请派 verify 子代理验证后收尾"——模型被告知了却不做,是 affordance 失败,不是纪律失败。
  it("按当前 PascalCase 约定注册,零参数、只读、自动放行", () => {
    expect(verifyDoneTool.name).toBe("VerifyDone");
    expect(verifyDoneTool.capability).toBe("read");
    expect(verifyDoneTool.approval).toBe("auto");
    // 零参数:和拿到 54% 采纳率的那一版保持一致,不额外加必填字段抬高调用门槛。
    expect(Object.keys((verifyDoneTool.schema as unknown as { shape: object }).shape)).toEqual([]);
  });

  it("返回证据纪律提醒,不替模型下「已完成」的结论", async () => {
    const out = await verifyDoneTool.handler({}, { workspaceRoot: "/tmp" } as never);
    // 三条由真实失败案例打磨出来的约束都在:方法(读≠验证)、范围(逐条对照任务原文)、
    // 疑点(不能凭感觉判断不重要就跳过)。
    expect(out).toContain("读≠验证");
    expect(out).toContain("每一条具体要求");
    expect(out).toContain("查到有确定");
    // 不能出现替模型下结论的措辞——它是检查点,不是判决器。
    expect(out).not.toMatch(/验收通过|任务已完成/);
  });

  it("在 auto 模式安全白名单里:即便配了 ask 规则也快速放行,不白跑一次分类器", () => {
    const rules = { ...emptyPermissions(), ask: ["VerifyDone"] };
    expect(decide({ toolName: "VerifyDone", argsJson: "{}", capability: "read", mode: "auto", rules })).toBe("allow");
  });

  it("在异步子代理可用工具白名单里(移除时被一并删掉的两处之一)", () => {
    expect(ASYNC_AGENT_ALLOWED_TOOLS.has("VerifyDone")).toBe(true);
  });
});
