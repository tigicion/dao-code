import { describe, it, expect } from "vitest";
import { estimateTokens, shouldCompact, compactMessages } from "./compact.js";
import type { ChatMessage } from "../client/types.js";

const sys: ChatMessage = { role: "system", content: "SYSTEM PREFIX" };
function user(t: string): ChatMessage { return { role: "user", content: t }; }
function asst(t: string): ChatMessage { return { role: "assistant", content: t }; }

const summarize = async (msgs: ChatMessage[]) => `SUMMARY(${msgs.length})`;

describe("compactMessages pinned 重注入", () => {
  it("压缩后把任务清单作为 system 消息重注入(穿越压缩)", async () => {
    const msgs: ChatMessage[] = [sys, user("a"), asst("ra"), user("b"), asst("rb"), user("c"), asst("rc")];
    const out = await compactMessages(
      msgs,
      { summarize: async () => "早期摘要内容" },
      "☐ 任务A\n▶ 任务B",
    );
    const joined = out.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(joined).toContain("当前任务清单");
    expect(joined).toContain("任务A");
    expect(joined).toContain("早期摘要内容");
  });
  it("无 pinned 时不注入任务清单", async () => {
    const msgs: ChatMessage[] = [sys, user("a"), asst("ra"), user("b"), asst("rb"), user("c"), asst("rc")];
    const out = await compactMessages(msgs, { summarize: async () => "x" });
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

describe("compactMessages 整段摘要(无 verbatim tail)", () => {
  it("只有 system → 原样返回(无可压)", async () => {
    const msgs = [sys];
    expect(await compactMessages(msgs, { summarize })).toEqual(msgs);
  });

  it("只剩旧摘要、无新内容 → 不动", async () => {
    const prior: ChatMessage = { role: "system", content: "[早期对话摘要——上下文超限已压缩,以下是早段对话的摘要]\n旧" };
    const msgs = [sys, prior];
    expect(await compactMessages(msgs, { summarize })).toEqual(msgs);
  });

  it("把 system 之后的【全部】对话塌成一条摘要:结构 [system, 摘要],摘要器收到 system+全部", async () => {
    const msgs = [sys, user("u1"), asst("a1"), user("u2"), asst("a2"), user("u3"), asst("a3")];
    const out = await compactMessages(msgs, { summarize });
    expect(out[0]).toEqual(sys);
    expect(out[1]!.role).toBe("system");
    expect(out[1]!.content).toContain("早期对话摘要");
    // 摘要器收到 [system, ...全部对话] = 7 条(命中主对话热缓存的完整前缀);无 verbatim tail。
    expect(out[1]!.content).toContain("SUMMARY(7)");
    expect(out.length).toBe(2); // 无 pin、无 tail
  });
});

// ④ 增量压缩:已有旧摘要时,旧摘要【文本】原样保留、不二次摘要,只追加新增;旧摘要仍随前缀发以命中缓存。
describe("compactMessages 增量(④)", () => {
  it("旧摘要 verbatim 保留 + 追加新增;旧摘要随前缀一起发(命中缓存),代码侧不二次摘要", async () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "SYS" },
      { role: "system", content: "[早期对话摘要——上下文超限已压缩,以下是早段对话的摘要]\n旧:做了 A" },
      user("新1"), asst("n1"), user("近1"), asst("c1"),
    ];
    let summarizeInput = "";
    const out = await compactMessages(
      msgs,
      { summarize: async (m) => { summarizeInput = m.map((x) => x.content).join("|"); return "新摘要:做了 B"; } },
    );
    const sum = out.find((m) => typeof m.content === "string" && m.content.includes("旧:做了 A"))!;
    expect(sum.content).toContain("旧:做了 A"); // 旧摘要文本逐字保留(代码前置,不靠模型)
    expect(sum.content).toContain("新摘要:做了 B"); // 追加新增
    expect(summarizeInput).toContain("旧:做了 A"); // 旧摘要随前缀发给摘要器 → 命中主对话热缓存
    expect(summarizeInput).toContain("SYS"); // [system, ...全部]:system 前置,前缀对齐热缓存
    expect(summarizeInput).toContain("新1"); // 新消息在内
  });
});

// L2.3 压缩降级:summarize 抛错时,压缩不崩——硬截断保留 system 锚 + 任务清单(无 tail)。
describe("compactMessages 降级(summarize 失败→硬截断)", () => {
  it("summarize 抛错 → 不抛、回退硬截断(system + 标记 + pinned),无 verbatim tail", async () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "SYS" },
      user("旧1"), asst("a1"), user("近2"), asst("c1"),
    ];
    const out = await compactMessages(
      msgs,
      { summarize: async () => { throw new Error("flash down"); } },
      "[ ] 完成功能 X",
    );
    expect(out[0]).toEqual({ role: "system", content: "SYS" }); // 系统锚保留
    expect(out.some((m) => typeof m.content === "string" && m.content.includes("早期对话已截断"))).toBe(true); // 硬截断标记
    expect(out.some((m) => typeof m.content === "string" && m.content.includes("完成功能 X"))).toBe(true); // 任务清单穿过
    expect(out.some((m) => m.content === "近2")).toBe(false); // 无 verbatim tail,近期也已舍弃
  });
});

// 缓存不变式:压缩后唯一仍命中缓存的是 system 锚点(逐字节不变、同引用)——压缩本就从新摘要处断开前缀。
describe("compactMessages 缓存不变式", () => {
  it("system 锚点同引用、逐字节不变;结构 [system, 摘要]", async () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "SYS-ANCHOR" },
      user("旧1"), asst("a1"), user("近1"), asst("a2"),
    ];
    const out = await compactMessages(msgs, { summarize: async () => "SUMMARY" });
    expect(out[0]).toBe(msgs[0]); // 同一引用 → 系统段仍命中缓存
    expect(out[0]).toEqual({ role: "system", content: "SYS-ANCHOR" });
    expect(out[1]).toMatchObject({ role: "system" });
    expect(out[1]!.content as string).toContain("SUMMARY");
    expect(out.length).toBe(2); // 无 tail
  });
});
