import { describe, it, expect } from "vitest";
import { estimateTokens, shouldCompact, compactMessages } from "./compact.js";
import type { ChatMessage } from "../client/types.js";

const sys: ChatMessage = { role: "system", content: "SYSTEM PREFIX" };
function user(t: string): ChatMessage { return { role: "user", content: t }; }
function asst(t: string): ChatMessage { return { role: "assistant", content: t }; }

describe("estimateTokens", () => {
  it("scales with content length and counts tool_calls args", () => {
    const t1 = estimateTokens([user("abc")]);
    const t2 = estimateTokens([user("abcdef")]);
    expect(t2).toBeGreaterThan(t1);
    const withTool = estimateTokens([
      { role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] },
    ]);
    expect(withTool).toBeGreaterThan(0);
  });
});

describe("shouldCompact", () => {
  it("true only at/over the threshold", () => {
    const msgs = [user("x".repeat(300))]; // ~100 tokens
    expect(shouldCompact(msgs, 1000, 0.05)).toBe(true);
    expect(shouldCompact(msgs, 1000, 0.9)).toBe(false);
  });
});

describe("compactMessages", () => {
  const summarize = async (msgs: ChatMessage[]) => `SUMMARY(${msgs.length})`;

  it("is a no-op when there are not more than keepRecentTurns user turns", async () => {
    const msgs = [sys, user("u1"), asst("a1"), user("u2"), asst("a2")];
    const out = await compactMessages(msgs, { keepRecentTurns: 2, summarize });
    expect(out).toEqual(msgs);
  });

  it("keeps system + summary + recent N turns (verbatim), summarizing the middle", async () => {
    const msgs = [
      sys,
      user("u1"), asst("a1"),
      user("u2"), asst("a2"),
      user("u3"), asst("a3"),
    ];
    const out = await compactMessages(msgs, { keepRecentTurns: 1, summarize });
    expect(out[0]).toEqual(sys);
    expect(out[1]!.role).toBe("system");
    expect(out[1]!.content).toContain("早期对话摘要");
    expect(out[1]!.content).toContain("SUMMARY(4)");
    expect(out.slice(2)).toEqual([user("u3"), asst("a3")]);
  });

  it("keeps complete turns including tool messages in the recent tail", async () => {
    const toolTurn: ChatMessage[] = [
      user("do it"),
      { role: "assistant", content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c0", content: "RESULT" },
      asst("done"),
    ];
    const msgs = [sys, user("old"), asst("oldA"), ...toolTurn];
    const out = await compactMessages(msgs, { keepRecentTurns: 1, summarize });
    expect(out.slice(2)).toEqual(toolTurn);
  });
});
