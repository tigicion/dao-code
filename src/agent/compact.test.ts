import { describe, it, expect } from "vitest";
import { estimateTokens, shouldCompact, compactMessages } from "./compact.js";
import type { ChatMessage } from "../client/types.js";

const sys: ChatMessage = { role: "system", content: "SYSTEM PREFIX" };
function user(t: string): ChatMessage { return { role: "user", content: t }; }
function asst(t: string): ChatMessage { return { role: "assistant", content: t }; }

describe("compactMessages pinned 重注入", () => {
  it("压缩后把任务清单作为 system 消息重注入(穿越压缩)", async () => {
    const msgs: ChatMessage[] = [sys, user("a"), asst("ra"), user("b"), asst("rb"), user("c"), asst("rc")];
    const out = await compactMessages(
      msgs,
      { keepRecentTurns: 1, summarize: async () => "早期摘要内容" },
      "☐ 任务A\n▶ 任务B",
    );
    const joined = out.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(joined).toContain("当前任务清单");
    expect(joined).toContain("任务A");
    expect(joined).toContain("早期摘要内容");
  });
  it("无 pinned 时不注入任务清单", async () => {
    const msgs: ChatMessage[] = [sys, user("a"), asst("ra"), user("b"), asst("rb"), user("c"), asst("rc")];
    const out = await compactMessages(msgs, { keepRecentTurns: 1, summarize: async () => "x" });
    expect(out.map((m) => m.content).join("\n")).not.toContain("当前任务清单");
  });
});

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

import { microcompactMessages } from "./compact.js";
describe("microcompactMessages", () => {
  const asst = (id: string, name: string) => ({ role: "assistant" as const, content: "", tool_calls: [{ id, type: "function" as const, function: { name, arguments: "{}" } }] });
  const tool = (id: string, content: string) => ({ role: "tool" as const, tool_call_id: id, content });
  const user = (c: string) => ({ role: "user" as const, content: c });
  it("清旧的可重现工具结果,保留写结果与近期", () => {
    const msgs = [
      { role: "system" as const, content: "sys" },
      user("t1"), asst("a1", "read_file"), tool("a1", "老文件内容很长"),
      asst("a2", "write_file"), tool("a2", "已写入 x"),
      user("t2"), user("t3"),
      asst("a3", "read_file"), tool("a3", "近期读取,保留"),
    ];
    const out = microcompactMessages(msgs, 2);
    expect(out.find((m) => m.role === "tool" && m.tool_call_id === "a1")!.content).toContain("已清理"); // 旧 read 清掉
    expect(out.find((m) => m.role === "tool" && m.tool_call_id === "a2")!.content).toBe("已写入 x"); // 写结果保留
    expect(out.find((m) => m.role === "tool" && m.tool_call_id === "a3")!.content).toBe("近期读取,保留"); // 近期保留
  });
  it("会话太短不动", () => {
    const msgs = [{ role: "user" as const, content: "x" }];
    expect(microcompactMessages(msgs, 2)).toEqual(msgs);
  });
});
