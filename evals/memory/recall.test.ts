import { describe, it, expect } from "vitest";
import { gradeRecall } from "./recall.js";

function fakeStream(text: string) { return async function* () { yield { kind: "content", text }; return { role: "assistant", content: text }; }(); }
const cfg = { model: "x", baseUrl: "x", apiKey: "x", judgeK: 1 };

describe("gradeRecall", () => {
  it("注入命中 valueGold → P/R 高;stale 泄漏=0;相关性缺口按 judge 算", async () => {
    // judge 对 relevance 恒 true(都相关)
    const streamChat = () => fakeStream('{"relevant":true}');
    const s = await gradeRecall({
      injectedNames: ["a", "b"], staleNames: [],
      store: [{ name: "a", text: "x" }, { name: "b", text: "y" }, { name: "c", text: "z" }],
      ctx: { task: "做滑梯", valueGold: ["a", "b"], relevanceGold: ["a", "b", "c"] },
      streamChat: streamChat as any, cfg,
    });
    expect(s.valuePR.r).toBe(1);
    expect(s.staleLeak).toBe(0);
    expect(s.relevanceGapValue).toBeCloseTo(1 / 3);   // 对人工金标:c 相关但没注入
    expect(s.judgeHumanAgreement).toBe(1);            // judge{a,b,c} == 人工{a,b,c}
  });

  it("stale 出现在注入集 → staleLeak>0(硬规则违反)", async () => {
    const streamChat = () => fakeStream('{"relevant":false}');
    const s = await gradeRecall({
      injectedNames: ["a", "s1"], staleNames: ["s1"],
      store: [{ name: "a", text: "x" }, { name: "s1", text: "stale" }],
      ctx: { task: "t", valueGold: ["a"], relevanceGold: [] },
      streamChat: streamChat as any, cfg,
    });
    expect(s.staleLeak).toBe(1);
    expect(s.relevanceGapValue).toBe(0);              // 人工金标为空 → 缺口 0
    expect(s.judgeHumanAgreement).toBe(0);            // f1(空, 空) = 0
  });
});
