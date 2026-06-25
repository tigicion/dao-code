import { describe, it, expect } from "vitest";
import { shouldCaptureMemory, turnHadVerifyPass, looksLikeCorrection, turnWroteMemory } from "./capture_policy.js";

describe("shouldCaptureMemory", () => {
  const T = 15000;
  it("没新材料 → 不捕获(即便压缩在即)", () => {
    expect(shouldCaptureMemory({ newTokens: 0, threshold: T, compactionImminent: true }).capture).toBe(false);
  });
  it("压缩前 + 有新材料 → 捕获(即便未达阈值)", () => {
    const r = shouldCaptureMemory({ newTokens: 100, threshold: T, compactionImminent: true });
    expect(r).toEqual({ capture: true, reason: "pre-compaction" });
  });
  it("verify 通过 + 有新材料 → 捕获(即便未达阈值)", () => {
    const r = shouldCaptureMemory({ newTokens: 100, threshold: T, verifyPassed: true });
    expect(r).toEqual({ capture: true, reason: "verify-passed" });
  });
  it("用户纠正 + 有新材料 → 捕获(即便未达阈值)", () => {
    const r = shouldCaptureMemory({ newTokens: 100, threshold: T, userCorrection: true });
    expect(r).toEqual({ capture: true, reason: "user-correction" });
  });
  it("用户纠正但没新材料 → 仍不捕获(守卫优先)", () => {
    expect(shouldCaptureMemory({ newTokens: 0, threshold: T, userCorrection: true }).capture).toBe(false);
  });
  it("本轮已主动 memory_write → 抑制 user-correction(同轮不重复蒸)", () => {
    const r = shouldCaptureMemory({ newTokens: 100, threshold: T, userCorrection: true, activeWriteThisTurn: true });
    expect(r).toEqual({ capture: false, reason: "below-threshold" });
  });
  it("本轮已主动 memory_write → 抑制 verify-passed(同轮不重复蒸)", () => {
    const r = shouldCaptureMemory({ newTokens: 100, threshold: T, verifyPassed: true, activeWriteThisTurn: true });
    expect(r).toEqual({ capture: false, reason: "below-threshold" });
  });
  it("本轮已主动 memory_write 但 token 攒够 → 仍蒸(抓的是别的新材料,重叠由 upsert 合并)", () => {
    const r = shouldCaptureMemory({ newTokens: T, threshold: T, userCorrection: true, activeWriteThisTurn: true });
    expect(r).toEqual({ capture: true, reason: "token-threshold" });
  });
  it("本轮已主动 memory_write 但压缩在即 → 仍捕获(安全兜底优先)", () => {
    const r = shouldCaptureMemory({ newTokens: 100, threshold: T, compactionImminent: true, activeWriteThisTurn: true });
    expect(r).toEqual({ capture: true, reason: "pre-compaction" });
  });
  it("达阈值 → 捕获", () => {
    expect(shouldCaptureMemory({ newTokens: T, threshold: T }).reason).toBe("token-threshold");
  });
  it("有新材料但未达阈值、无事件 → 跳过(多数回合)", () => {
    expect(shouldCaptureMemory({ newTokens: T - 1, threshold: T })).toEqual({ capture: false, reason: "below-threshold" });
  });
});

describe("turnHadVerifyPass", () => {
  it("本轮有 verify_done 客观通过的工具结果 → true", () => {
    const msgs = [
      { role: "assistant", content: "跑一下验收" },
      { role: "tool", content: "$ npm test\n...\n[验收通过 exit 0]" },
    ];
    expect(turnHadVerifyPass(msgs)).toBe(true);
  });
  it("验收失败 → false", () => {
    const msgs = [{ role: "tool", content: "$ npm test\n...\n[验收失败 exit 1]" }];
    expect(turnHadVerifyPass(msgs)).toBe(false);
  });
  it("未配验收命令的自判模式 → 不算客观通过 → false", () => {
    const msgs = [{ role: "tool", content: "(未配置可执行验收命令)据【实际证据】自判…" }];
    expect(turnHadVerifyPass(msgs)).toBe(false);
  });
  it("通过标记若出现在 assistant 文本而非工具结果 → 不认(只认 tool 角色)", () => {
    const msgs = [{ role: "assistant", content: "我觉得 [验收通过 exit 0] 了吧" }];
    expect(turnHadVerifyPass(msgs)).toBe(false);
  });
  it("空轮/无工具结果 → false", () => {
    expect(turnHadVerifyPass([{ role: "assistant", content: "好的" }])).toBe(false);
  });
});

describe("looksLikeCorrection", () => {
  it("中文纠正/强调 → true", () => {
    for (const t of ["不对,应该用 X", "别再加 emoji", "我说过要中文", "以后一律先读再写", "记住:提交不加署名",
      "后面思考都要用中文", "后面回答也总是用中文"]) {
      expect(looksLikeCorrection(t)).toBe(true);
    }
  });
  it("英文纠正/强调 → true(大小写无关)", () => {
    for (const t of ["Don't use emoji", "you SHOULD test first", "stop doing that", "always run typecheck"]) {
      expect(looksLikeCorrection(t)).toBe(true);
    }
  });
  it("普通指令/问题 → false(不该几乎每轮都触发)", () => {
    for (const t of ["帮我加个登录页", "这个函数怎么用", "跑一下测试", "看看 README"]) {
      expect(looksLikeCorrection(t)).toBe(false);
    }
  });
  it("空串 → false", () => {
    expect(looksLikeCorrection("")).toBe(false);
  });
  it("英文线索按词边界,不误伤 now/know 等", () => {
    expect(looksLikeCorrection("I know this now")).toBe(false);
  });
});

describe("turnWroteMemory", () => {
  it("本轮 assistant 调过 memory_write → true", () => {
    const msgs = [
      { role: "assistant", tool_calls: [{ function: { name: "memory_write" } }] },
      { role: "tool", content: "已记住(用户级):…" },
    ];
    expect(turnWroteMemory(msgs)).toBe(true);
  });
  it("本轮只调别的工具 → false", () => {
    const msgs = [{ role: "assistant", tool_calls: [{ function: { name: "read_file" } }] }];
    expect(turnWroteMemory(msgs)).toBe(false);
  });
  it("无 tool_calls 的纯文本回合 → false", () => {
    expect(turnWroteMemory([{ role: "assistant", content: "好的" } as never])).toBe(false);
  });
});
