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

  it("脱敏 assistant.toolCalls[].args(否则 args 里的路径/专名会泄漏进进仓 fixture)", () => {
    const out = redactEvents(
      [{ t: "assistant", content: "好", toolCalls: [{ name: "write_file", args: "{\"path\":\"/Users/alice/Proj/PeppaSlide/x\"}" }] }] as any,
      { homedir: "/Users/alice", nameMap: { PeppaSlide: "GameX" } },
    );
    const args = (out[0] as any).toolCalls[0].args as string;
    expect(args).toContain("~/Proj/GameX/x");
    expect(args).not.toContain("/Users/alice");
    expect(args).not.toContain("PeppaSlide");
  });
});
