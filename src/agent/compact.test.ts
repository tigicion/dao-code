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

  // 单 user 轮(一次性/自主长任务):user 轮 ≤ keepRecentTurns 时,fallback 按【工具周期】切,
  // 仍清掉旧的可重现工具结果。否则一次性长任务永远压不了缩(单轮缺口)。
  it("单 user 轮也清旧可重现结果(按工具周期切),写结果与近期保留", () => {
    const msgs = [
      { role: "system" as const, content: "sys" },
      user("实现整个工具库"), // 唯一 user 轮
      asst("a1", "read_file"), tool("a1", "旧读取-应清"),
      asst("a2", "write_file"), tool("a2", "旧写结果-应保留"),
      asst("a3", "read_file"), tool("a3", "近期读取-应保留"),
      asst("a4", "read_file"), tool("a4", "近期读取2-应保留"),
    ];
    const out = microcompactMessages(msgs, 2); // 保留最近 2 个工具周期(a3、a4)
    expect(out.find((m) => m.role === "tool" && m.tool_call_id === "a1")!.content).toContain("已清理"); // 旧 read 清掉
    expect(out.find((m) => m.role === "tool" && m.tool_call_id === "a2")!.content).toBe("旧写结果-应保留"); // 写结果永不清(即便旧)
    expect(out.find((m) => m.role === "tool" && m.tool_call_id === "a3")!.content).toBe("近期读取-应保留"); // 近期保留
    expect(out.find((m) => m.role === "tool" && m.tool_call_id === "a4")!.content).toBe("近期读取2-应保留"); // 近期保留
  });
});

// L2.3 压缩降级:summarize 抛错时,压缩不崩——硬截断保留 system 锚 + 近期 + 任务清单。
describe("compactMessages 降级(summarize 失败→硬截断)", () => {
  const user = (c: string) => ({ role: "user" as const, content: c });
  const asst = (c: string) => ({ role: "assistant" as const, content: c });
  it("summarize 抛错 → 不抛、回退硬截断(system + 标记 + tail + pinned)", async () => {
    const msgs = [
      { role: "system" as const, content: "SYS" },
      user("旧1"), asst("a1"),
      user("近1"), asst("b1"),
      user("近2"), asst("c1"),
    ];
    const out = await compactMessages(
      msgs,
      { keepRecentTurns: 2, summarize: async () => { throw new Error("flash down"); } },
      "[ ] 完成功能 X",
    );
    expect(out[0]).toEqual({ role: "system", content: "SYS" }); // 系统锚保留
    expect(out.some((m) => typeof m.content === "string" && m.content.includes("早期对话已截断"))).toBe(true); // 硬截断标记
    expect(out.some((m) => typeof m.content === "string" && m.content.includes("完成功能 X"))).toBe(true); // 任务清单穿过
    expect(out.some((m) => m.content === "近2")).toBe(true); // 近期保留
    expect(out.some((m) => m.content === "旧1")).toBe(false); // 早段舍弃
  });
});

// ④ 增量压缩:已有旧摘要时,旧摘要原样保留、只摘要新消息,拼成"旧+新"。
describe("compactMessages 增量(④)", () => {
  const user = (c: string) => ({ role: "user" as const, content: c });
  const asst = (c: string) => ({ role: "assistant" as const, content: c });
  it("保留旧摘要 verbatim + 追加新增,不二次摘要旧摘要", async () => {
    const msgs = [
      { role: "system" as const, content: "SYS" },
      { role: "system" as const, content: "[早期对话摘要——上下文超限已压缩,以下是早段对话的摘要]\n旧:做了 A" },
      user("新1"), asst("n1"), user("新2"), asst("n2"), user("近1"), asst("c1"),
    ];
    let summarizeInput = "";
    const out = await compactMessages(
      msgs,
      { keepRecentTurns: 1, summarize: async (m) => { summarizeInput = m.map((x) => x.content).join("|"); return "新摘要:做了 B"; } },
    );
    const sum = out.find((m) => typeof m.content === "string" && m.content.includes("旧:做了 A"))!;
    expect(sum.content).toContain("旧:做了 A"); // 旧摘要保留
    expect(sum.content).toContain("新摘要:做了 B"); // 追加新增
    expect(summarizeInput).not.toContain("旧:做了 A"); // 旧摘要没被再喂去摘要(省 + 不丢真)
    expect(summarizeInput).toContain("新1"); // 只摘要新消息
  });
});

// P0-1 缓存不变式回归:压缩后,system 锚点逐字节不变、保留的近期段(tail)绝不被改写——
// 这样压缩产物 [system, summary, ...tail] 的 system 段仍命中缓存,且 tail 内容未被
// microcompact 污染。任何把 microcompact 漏到 tail 的回归都会让这些断言失败。
describe("compactMessages 缓存不变式", () => {
  const asst = (id: string, name: string) => ({ role: "assistant" as const, content: "", tool_calls: [{ id, type: "function" as const, function: { name, arguments: "{}" } }] });
  const tool = (id: string, content: string) => ({ role: "tool" as const, tool_call_id: id, content });
  const user = (c: string) => ({ role: "user" as const, content: c });
  it("system 锚点逐字节不变,保留段(tail)原样、不被 microcompact 清理", async () => {
    const msgs = [
      { role: "system" as const, content: "SYS-ANCHOR" },
      user("旧1"), asst("a1", "read_file"), tool("a1", "旧的可重现结果"),
      user("近1"), asst("a2", "read_file"), tool("a2", "近期可重现结果-必须保留"),
      user("近2"), asst("a3", "write_file"), tool("a3", "近期写结果"),
    ];
    const tailBefore = msgs.slice(4); // 最近 2 个 user 轮:近1…、近2…
    const out = await compactMessages(msgs, { keepRecentTurns: 2, summarize: async () => "SUMMARY" });

    // system 锚点逐字节不变(同一引用)→ 压缩后系统段仍命中缓存
    expect(out[0]).toBe(msgs[0]);
    expect(out[0]).toEqual({ role: "system", content: "SYS-ANCHOR" });
    // 结构:system + 摘要 + 保留 tail
    expect(out[1]).toMatchObject({ role: "system" });
    expect((out[1]!.content as string)).toContain("SUMMARY");
    // 保留段逐条原样(含近期可重现结果),绝不被 CLEARED_MARK 污染
    expect(out.slice(out.length - tailBefore.length)).toEqual(tailBefore);
    expect(out.find((m) => m.role === "tool" && (m as any).tool_call_id === "a2")!.content).toBe("近期可重现结果-必须保留");
  });
});
