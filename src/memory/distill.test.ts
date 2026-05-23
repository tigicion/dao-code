import { describe, it, expect } from "vitest";
import { distill } from "./distill.js";

function fakeStream(text: string) {
  return async function* () { yield { kind: "content", text }; return { role: "assistant", content: text }; }();
}

describe("distill", () => {
  it("parses distilled memories and gates importance", async () => {
    const json = JSON.stringify([
      { text: "用户在学 agent 原理,偏好讲机制", type: "user", importance: 7, confidence: 0.6 },
      { text: "随口一句", type: "episodic", importance: 2 },
    ]);
    const mems = await distill({
      streamChat: () => fakeStream("```json\n" + json + "\n```"),
      config: { baseUrl: "x", apiKey: "x" }, model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "..." }], today: "2026-06-07",
    } as any);
    expect(mems.length).toBe(1); // importance<4 被滤
    expect(mems[0]).toMatchObject({ type: "user", importance: 7, confidence: 0.6 });
    expect(mems[0]?.created).toBe("2026-06-07");
  });

  it("returns [] on non-JSON", async () => {
    const mems = await distill({ streamChat: () => fakeStream("抱歉无法"), config: {}, model: "x", messages: [], today: "2026-06-07" } as any);
    expect(mems).toEqual([]);
  });
});
