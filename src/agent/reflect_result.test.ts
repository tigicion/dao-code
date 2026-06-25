import { describe, it, expect } from "vitest";
import { parseReflectResult } from "./reflect_result.js";

describe("parseReflectResult — 两段独立容错解析", () => {
  it("正常 JSON:onTrack + advisory + memories 全解析", () => {
    const raw = JSON.stringify({
      onTrack: false,
      advisory: "你在反复改 foo.ts:42,根因可能在 bar.ts",
      memories: [{ title: "提交不加 AI 署名", text: "提交一律不加署名。为什么:用户要求。怎么用:不写 Co-Authored-By。", type: "feedback", importance: 9 }],
    });
    const r = parseReflectResult(raw);
    expect(r.onTrack).toBe(false);
    expect(r.advisory).toContain("foo.ts");
    expect(r.memories).toHaveLength(1);
    expect(r.memories[0]).toMatchObject({ title: "提交不加 AI 署名", type: "feedback", importance: 9 });
  });

  it("带 ```json 围栏也能抽出来", () => {
    const raw = "好的\n```json\n" + JSON.stringify({ onTrack: true, advisory: null, memories: [] }) + "\n```";
    expect(parseReflectResult(raw)).toEqual({ onTrack: true, advisory: null, memories: [] });
  });

  it("onTrack=true 时强制 advisory=null(就算模型给了文本)", () => {
    const raw = JSON.stringify({ onTrack: true, advisory: "在轨,继续", memories: [] });
    expect(parseReflectResult(raw).advisory).toBeNull();
  });

  it("缺 onTrack:有非空 advisory 推断为 false,否则 true", () => {
    expect(parseReflectResult(JSON.stringify({ advisory: "有问题", memories: [] })).onTrack).toBe(false);
    expect(parseReflectResult(JSON.stringify({ advisory: null, memories: [] })).onTrack).toBe(true);
  });

  it("memories 里坏条目被丢、好条目保留(字段级降级)", () => {
    const raw = JSON.stringify({
      onTrack: true, advisory: null,
      memories: [
        { title: "好的一条", text: "完整事实", type: "user" },
        { title: "缺 text", type: "user" },          // 丢
        { text: "缺 title", type: "feedback" },        // 丢
        { title: "坏 type", text: "x", type: "乱写" }, // 丢
      ],
    });
    const r = parseReflectResult(raw);
    expect(r.memories).toHaveLength(1);
    expect(r.memories[0]!.title).toBe("好的一条");
  });

  it("advisory 段坏(不是字符串)→ advisory 降级 null,但 memories 仍保留(两段解耦)", () => {
    const raw = JSON.stringify({ onTrack: false, advisory: { 乱: "对象" }, memories: [{ title: "t", text: "x", type: "semantic" }] });
    const r = parseReflectResult(raw);
    expect(r.advisory).toBeNull();
    expect(r.memories).toHaveLength(1);
  });

  it("整体不是 JSON → 安全默认(什么都不做,不丢不注入)", () => {
    expect(parseReflectResult("模型胡言乱语没有 JSON")).toEqual({ onTrack: true, advisory: null, memories: [] });
  });

  it("memories 不是数组 → []", () => {
    expect(parseReflectResult(JSON.stringify({ onTrack: true, advisory: null, memories: "oops" })).memories).toEqual([]);
  });

  it("mergeInto 透传(合并意图)", () => {
    const raw = JSON.stringify({ onTrack: true, advisory: null, memories: [{ title: "t", text: "x", type: "user", mergeInto: "已有标题" }] });
    expect(parseReflectResult(raw).memories[0]!.mergeInto).toBe("已有标题");
  });
});
