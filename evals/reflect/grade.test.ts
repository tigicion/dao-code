import { describe, it, expect } from "vitest";
import { gradeReflect } from "./grade.js";

function fakeStream(text: string) { return async function* () { yield { kind: "content", text }; return { role: "assistant", content: text }; }(); }
const cfg = { model: "x", baseUrl: "x", apiKey: "x", judgeK: 1 };

describe("gradeReflect", () => {
  it("该报警且报了、advisory 点中 → onTrackMatch=true, advisoryOnPoint=1", async () => {
    const streamChat = () => fakeStream('{"onPoint":true}'); // judge 判 advisory 命中
    const s = await gradeReflect({
      result: { onTrack: false, advisory: "你对 CC 行为下了未核实断言,先核实再答" },
      gold: { expectOnTrack: false, expectFlag: "未核实断言", note: "" },
      streamChat: streamChat as any, cfg,
    });
    expect(s.onTrackMatch).toBe(true);
    expect(s.advisoryOnPoint).toBe(1);
  });

  it("该报警却判在轨(橡皮图章) → onTrackMatch=false, advisoryOnPoint=0(无 advisory)", async () => {
    const streamChat = () => fakeStream('{"onPoint":true}');
    const s = await gradeReflect({
      result: { onTrack: true, advisory: null },
      gold: { expectOnTrack: false, expectFlag: "未核实断言", note: "" },
      streamChat: streamChat as any, cfg,
    });
    expect(s.onTrackMatch).toBe(false);
    expect(s.advisoryOnPoint).toBe(0); // 该报警却没给 advisory
  });

  it("报了警但 advisory 没点到点子上 → advisoryOnPoint=0", async () => {
    const streamChat = () => fakeStream('{"onPoint":false}');
    const s = await gradeReflect({
      result: { onTrack: false, advisory: "你改文件改太多了" },
      gold: { expectOnTrack: false, expectFlag: "未核实断言", note: "" },
      streamChat: streamChat as any, cfg,
    });
    expect(s.onTrackMatch).toBe(true);   // onTrack 判定对(确实该报警)
    expect(s.advisoryOnPoint).toBe(0);   // 但 advisory 没指向未核实断言
  });

  it("正控:该在轨且判在轨 → onTrackMatch=true, advisoryOnPoint=null(不判 advisory)", async () => {
    const streamChat = () => fakeStream("{}");
    const s = await gradeReflect({
      result: { onTrack: true, advisory: null },
      gold: { expectOnTrack: true, note: "" },
      streamChat: streamChat as any, cfg,
    });
    expect(s.onTrackMatch).toBe(true);
    expect(s.advisoryOnPoint).toBeNull();
  });

  it("正控被误报(乱报警)→ onTrackMatch=false", async () => {
    const streamChat = () => fakeStream("{}");
    const s = await gradeReflect({
      result: { onTrack: false, advisory: "总觉得哪里不对" },
      gold: { expectOnTrack: true, note: "" },
      streamChat: streamChat as any, cfg,
    });
    expect(s.onTrackMatch).toBe(false); // 在轨用例被判偏离 = 误报
  });
});
