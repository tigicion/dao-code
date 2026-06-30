import { describe, it, expect } from "vitest";
import { parseJudgeJson, judgeBool, factCoveredPrompt, memoryQualityPrompt } from "./judge.js";

function fakeStream(text: string) {
  return async function* () { yield { kind: "content", text }; return { role: "assistant", content: text }; }();
}
const cfg = { model: "x", baseUrl: "x", apiKey: "x", judgeK: 3 };

describe("parseJudgeJson", () => {
  it("从含前后噪声的输出里抠出 JSON", () => {
    expect(parseJudgeJson('废话 {"covered":true} 尾巴')).toEqual({ covered: true });
    expect(parseJudgeJson("没有 json")).toBeNull();
  });
});

describe("rubric 构造", () => {
  it("factCoveredPrompt 含事实文本与所有抽出标题", () => {
    const p = factCoveredPrompt({ text: "用户有iPad给2岁孩子做游戏", type: "user", scope: "user" }, [{ title: "T1", text: "x" }]);
    expect(p).toContain("iPad"); expect(p).toContain("T1"); expect(p).toContain("covered");
  });
  it("memoryQualityPrompt 含四维度键", () => {
    const p = memoryQualityPrompt({ title: "T", text: "x" } as any);
    for (const k of ["durable", "typeScopeCorrect", "notCatalogDump", "actionable"]) expect(p).toContain(k);
  });
});

describe("judgeBool K 次多数票", () => {
  it("3 次里 2 真 → value=true、agreement=2/3", async () => {
    let i = 0;
    const outs = ['{"covered":true}', '{"covered":false}', '{"covered":true}'];
    const streamChat = () => fakeStream(outs[i++]!);
    const r = await judgeBool({ streamChat: streamChat as any, cfg, prompt: "x", key: "covered" }, 3);
    expect(r.value).toBe(true); expect(r.agreement).toBeCloseTo(2 / 3);
  });
});
