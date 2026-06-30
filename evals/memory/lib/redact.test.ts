import { describe, it, expect } from "vitest";
import { redactText, redactEvents } from "./redact.js";

describe("redactText", () => {
  it("抠密钥、归一 home 路径、替换专名,保留普通语义", () => {
    const r = redactText("key sk-ABCDEFGHIJKLMNOP1234 在 /Users/alice/Proj/slide 里做 PeppaSlide", {
      homedir: "/Users/alice", nameMap: { PeppaSlide: "GameX", slide: "projX" },
    });
    expect(r).not.toContain("sk-ABCDEFGHIJKLMNOP1234");
    expect(r).toContain("~/Proj/projX");
    expect(r).toContain("GameX");
    expect(r).toContain("做");                 // 普通语义保留
  });
});

describe("redactEvents", () => {
  it("对 user/assistant/tool_result 文本逐一脱敏", () => {
    const out = redactEvents([{ t: "user", text: "/Users/alice/x sk-ABCDEFGHIJKLMNOP1234" }] as any, { homedir: "/Users/alice" });
    expect((out[0] as any).text).toContain("~/x");
    expect((out[0] as any).text).not.toContain("sk-ABCDEFGHIJKLMNOP1234");
  });
});
