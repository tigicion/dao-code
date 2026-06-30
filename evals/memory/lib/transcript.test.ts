import { describe, it, expect } from "vitest";
import { toMessages, windowMessages, parseJsonl } from "./transcript.js";

describe("toMessages 事件映射", () => {
  it("user → user;assistant(content)→assistant;tool_result → 截断的 user 摘要;turn_end/notice 丢弃", () => {
    const ev = [
      { t: "user", text: "做个滑梯游戏" },
      { t: "assistant", content: "好的", toolCalls: [{ name: "list_dir", args: "{\"path\":\"/x\"}" }] },
      { t: "tool_result", name: "list_dir", ok: true, content: "a\n".repeat(5000) },
      { t: "turn_end" },
      { t: "notice", text: "[反思:...]" },
    ] as const;
    const msgs = toMessages(ev as any, { toolResultCap: 100 });
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[2]!.content.length).toBeLessThan(160);          // tool_result 被截断
    expect(msgs[2]!.content).toContain("list_dir");
  });

  it("assistant content=null 时用 toolCalls 摘要(含工具名)", () => {
    const msgs = toMessages([{ t: "assistant", content: null, toolCalls: [{ name: "todo_write", args: "{}" }] }] as any);
    expect(msgs[0]!.role).toBe("assistant");
    expect(msgs[0]!.content).toContain("todo_write");
  });
});

describe("windowMessages 尾窗", () => {
  it("超长时只保留尾部、总量受限", () => {
    const big = Array.from({ length: 50 }, (_, i) => ({ role: "user", content: "x".repeat(1000) + `#${i}` }));
    const out = windowMessages(big, 5000);
    const total = out.reduce((n, m) => n + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(5000);
    expect(out[out.length - 1]!.content).toContain("#49");      // 尾部保留
  });
});

describe("parseJsonl", () => {
  it("逐行解析、跳过坏行", () => {
    const raw = '{"t":"user","text":"a"}\n坏行\n{"t":"turn_end"}\n';
    expect(parseJsonl(raw).length).toBe(2);
  });
});
