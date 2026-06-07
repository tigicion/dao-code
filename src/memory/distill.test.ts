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

  it("excludes system messages from the rendered transcript (so the huge system prompt can't crowd out / derail)", async () => {
    let sent = "";
    const capture = (opts: any) => {
      sent = String(opts.messages[1]?.content ?? ""); // [0]=蒸馏器 system,[1]=渲染的对话
      return fakeStream("[]");
    };
    await distill({
      streamChat: capture,
      config: { baseUrl: "x", apiKey: "x" }, model: "x",
      messages: [
        { role: "system", content: "SYSTEM_PROMPT_SENTINEL_应被排除" },
        { role: "user", content: "我用 pnpm" },
        { role: "assistant", content: "好的" },
      ],
      today: "2026-06-07",
    } as any);
    expect(sent).not.toContain("SYSTEM_PROMPT_SENTINEL");
    expect(sent).toContain("我用 pnpm");
  });
});
