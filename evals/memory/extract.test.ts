import { describe, it, expect } from "vitest";
import { gradeExtraction } from "./extract.js";

function fakeStream(text: string) {
  return async function* () { yield { kind: "content", text }; return { role: "assistant", content: text }; }();
}
const cfg = { model: "x", baseUrl: "x", apiKey: "x", judgeK: 1 };

describe("gradeExtraction 接线", () => {
  it("mustExtract 全覆盖、无 mustNot 命中 → recall=1 precision=1", async () => {
    // judge:对覆盖判定恒返回 covered=true;质量恒高;mustNot 判定恒 false
    const streamChat = (o: any) => {
      const prompt = o.messages[0].content as string;
      if (prompt.includes("是否被任一")) return fakeStream('{"covered":true,"why":"x"}');
      if (prompt.includes("四维度")) return fakeStream('{"durable":1,"typeScopeCorrect":1,"notCatalogDump":1,"actionable":1}');
      return fakeStream('{"covered":false}');
    };
    const gold = {
      existing: [],
      mustExtract: [{ text: "用户有iPad给2岁孩子做游戏", type: "user" as const, scope: "user" as const, profile: true }],
      mustNot: [],
    };
    const extracted = [{ title: "画像", text: "用户长期给低龄儿童做iPad游戏", type: "user" }];
    const s = await gradeExtraction({ extracted, gold, streamChat: streamChat as any, cfg });
    expect(s.factRecall).toBe(1);
    expect(s.profileRecall).toBe(1);
    expect(s.precision).toBe(1);
    expect(s.quality).toBe(1);            // K=judgeK=1 → 单样本中位=1
    expect(s.qualityStdev).toBe(0);
    expect(s.typeScopeMatch).toBe(1);     // type "user" → routeScope "user" === scope "user"
  });

  it("漏掉画像事实 → profileRecall=0", async () => {
    const streamChat = () => fakeStream('{"covered":false,"why":"没覆盖"}');
    const gold = { existing: [], mustExtract: [{ text: "iPad给2岁孩子", type: "user" as const, scope: "user" as const, profile: true }], mustNot: [] };
    const s = await gradeExtraction({ extracted: [], gold, streamChat: streamChat as any, cfg });
    expect(s.profileRecall).toBe(0);
    expect(s.precision).toBeNull();         // 无抽出 → 精确率 N/A,不谄媚假 1.0
    expect(s.quality).toBeNull();           // 无抽出 → 不谄媚假 1.0
    expect(s.qualityStdev).toBeNull();
    expect(s.typeScopeMatch).toBe(0);       // 无抽出 → some 永假
  });

  it("无画像金标 → profileRecall=N/A(null),不假 1.0", async () => {
    const streamChat = () => fakeStream('{"covered":true}');
    const gold = { existing: [], mustExtract: [{ text: "某技术事实", type: "procedural" as const, scope: "knowledge" as const }], mustNot: [] };
    const s = await gradeExtraction({ extracted: [{ title: "x", text: "y", type: "procedural" }], gold, streamChat: streamChat as any, cfg });
    expect(s.profileRecall).toBeNull();
    expect(s.factRecall).toBe(1);
  });
});
