import { describe, it, expect } from "vitest";
import { runTurn } from "./loop.js";
import { compactMessages } from "./compact.js";
import { Session } from "../session/session.js";
import { ToolRegistry } from "../tools/registry.js";
import type { AssistantMessage, StreamChatOptions, ChatMessage } from "../client/types.js";

// 长任务韧性 eval(确定性故障注入,零成本、入 CI):脚本化 streamChat 在指定回合注入
// 断流/过载/上下文超限/压缩失败,断言"降级链生效、任务不崩、目标不丢"。
// 真实 API 的端到端校准(花钱)另说;韧性本身就该用可控故障来验。

const gen = (msg: AssistantMessage) => (async function* (): AsyncGenerator<never, AssistantMessage> { return msg; })();
const boom = (m: string) => (async function* (): AsyncGenerator<never, AssistantMessage> { throw new Error(m); })();
const toolMsg = (id: string, name: string) => ({ role: "assistant" as const, content: "", tool_calls: [{ id, type: "function" as const, function: { name, arguments: "{}" } }] });

function deps(session: Session, over: Partial<Record<string, unknown>> = {}) {
  return {
    session,
    config: { baseUrl: "x", apiKey: "x" },
    registry: new ToolRegistry(),
    ctx: { workspaceRoot: "/tmp", readFiles: new Set<string>() },
    gate: { needsApproval: () => false, requestBatch: async () => new Map() },
    streamChat: () => gen({ role: "assistant", content: "ok" }),
    executeToolCalls: async (tcs: any[]) => tcs.map((tc) => ({ role: "tool", tool_call_id: tc.id, content: "ok" })),
    write: () => {},
    ...over,
  } as any;
}

describe("长任务韧性 eval", () => {
  it("反应式压缩:上下文超限 → 压缩后重试本轮,任务继续不崩", async () => {
    let calls = 0, compacted = 0;
    const streamChat = (_o: StreamChatOptions) => {
      calls++;
      return calls === 1 ? boom("This model's maximum context length is 65536 tokens") : gen({ role: "assistant", content: "done" });
    };
    const s = new Session("SYS", "pro"); s.addUser("go");
    await runTurn(deps(s, { streamChat, compact: async () => { compacted++; } }));
    expect(compacted).toBe(1); // 触发了反应式压缩
    expect(s.messages.at(-1)).toMatchObject({ role: "assistant", content: "done" }); // 任务继续完成
  });

  it("模型回退:主模型 529 过载 → 本回合改用 fallback 跑完", async () => {
    const streamChat = (o: StreamChatOptions) =>
      o.model === "pro" ? boom("DeepSeek API error 529: overloaded") : gen({ role: "assistant", content: "ok" });
    const s = new Session("SYS", "pro"); s.addUser("go");
    await runTurn(deps(s, { streamChat, fallbackModel: "flash" }));
    expect(s.messages.at(-1)).toMatchObject({ role: "assistant", content: "ok" });
  });

  it("致命错误不被吞:400 bad request 直接上抛(不重试/不回退)", async () => {
    let calls = 0;
    const streamChat = () => { calls++; return boom("DeepSeek API error 400: bad request"); };
    const s = new Session("SYS", "pro"); s.addUser("go");
    await expect(runTurn(deps(s, { streamChat, fallbackModel: "flash" }))).rejects.toThrow(/400/);
    expect(calls).toBe(1); // 致命:不在 loop 层重试/回退
  });

  it("跨压缩:压缩保留 system 锚 + 任务清单(目标不漂移)", async () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "实现 X" }, { role: "assistant", content: "在做" },
      { role: "user", content: "继续" }, { role: "assistant", content: "ok" },
      { role: "user", content: "再继续" }, { role: "assistant", content: "ok2" },
    ];
    const out = await compactMessages(msgs, { summarize: async () => "早期做了 X 的一部分" }, "[ ] 完成 X 的剩余部分");
    expect(out[0]).toEqual({ role: "system", content: "SYS" }); // 系统锚穿过压缩
    expect(out.some((m) => typeof m.content === "string" && m.content.includes("完成 X 的剩余部分"))).toBe(true); // 任务清单穿过
  });

  it("压缩失败兜底:summarize 抛错 → 硬截断,任务仍可继续(不因压缩崩)", async () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "a" }, { role: "assistant", content: "1" },
      { role: "user", content: "b" }, { role: "assistant", content: "2" },
      { role: "user", content: "c" }, { role: "assistant", content: "3" },
    ];
    const out = await compactMessages(msgs, { summarize: async () => { throw new Error("flash down"); } }, "[ ] 任务X");
    expect(out[0]).toEqual({ role: "system", content: "SYS" });
    expect(out.some((m) => typeof m.content === "string" && m.content.includes("任务X"))).toBe(true);
    expect(out.length).toBeGreaterThan(1); // 没崩,产出了可继续的消息序列
  });

  it("综合:多轮任务穿过 注入故障(529→回退 + 上下文超限→压缩)后完成", async () => {
    let turn = 0, compacted = 0;
    const streamChat = (o: StreamChatOptions) => {
      turn++;
      if (turn === 1) return gen(toolMsg("t1", "read_file")); // 第1轮:正常调工具
      if (turn === 2) return o.model === "pro" ? boom("DeepSeek API error 529") : gen(toolMsg("t2", "write_file")); // 第2轮:529→回退
      if (turn === 3) return compacted === 0 ? boom("maximum context length exceeded") : gen({ role: "assistant", content: "完成" }); // 第3轮:超限→压缩重试
      return gen({ role: "assistant", content: "完成" });
    };
    const s = new Session("SYS", "pro"); s.addUser("做个多步任务");
    await runTurn(deps(s, { streamChat, fallbackModel: "flash", compact: async () => { compacted++; } }));
    expect(compacted).toBe(1);
    expect(s.messages.at(-1)).toMatchObject({ role: "assistant", content: "完成" });
  });
});
