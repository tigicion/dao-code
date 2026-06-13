import { describe, it, expect } from "vitest";
import { runTurn } from "./loop.js";
import { Session } from "../session/session.js";
import { ToolRegistry } from "../tools/registry.js";
import type { AssistantMessage, StreamChatOptions } from "../client/types.js";

function baseDeps(session: Session, streamChat: any, executeToolCalls: any) {
  return {
    session,
    config: { baseUrl: "x", apiKey: "x" },
    registry: new ToolRegistry(),
    ctx: { workspaceRoot: "/tmp", readFiles: new Set<string>() },
    gate: { needsApproval: () => false, requestBatch: async () => new Map() },
    streamChat,
    executeToolCalls,
    write: () => {},
  } as any;
}

describe("L4.2/L4.3 advisor", () => {
  it("连续空转 N 轮后,进度提醒【持久 append 进会话】(下一轮请求带上;缓存安全)", async () => {
    process.env.DAO_ADVISE_EVERY = "2";
    const sentLog: any[] = [];
    let turn = 0;
    const streamChat = (opts: StreamChatOptions) => {
      sentLog.push([...opts.messages]);
      turn++;
      return (async function* (): AsyncGenerator<never, AssistantMessage> {
        if (turn <= 3) return { role: "assistant", content: "", tool_calls: [{ id: "t" + turn, type: "function", function: { name: "read_file", arguments: "{}" } }] };
        return { role: "assistant", content: "done" };
      })();
    };
    const executeToolCalls = async (tcs: any[]) => tcs.map((tc) => ({ role: "tool", tool_call_id: tc.id, content: "ok" }));
    const s = new Session("SYS", "m");
    s.addUser("go");
    await runTurn(baseDeps(s, streamChat, executeToolCalls));
    delete process.env.DAO_ADVISE_EVERY;

    const advisoryIn = (msgs: any[]) => msgs.some((m) => typeof m.content === "string" && m.content.includes("进度提醒"));
    expect(advisoryIn(sentLog[0])).toBe(false); // 第1次:还没空转
    expect(advisoryIn(sentLog[2])).toBe(true); // 第3次:已空转2轮 → 上一轮末已 append 提醒,本轮请求带上
    // 提醒【持久写回 session】(append-only,缓存安全),而非用完即弃的尾部临时注入
    expect(s.messages.some((m) => typeof m.content === "string" && m.content.includes("进度提醒"))).toBe(true);
  });

  it("有文件改动则不提醒(进度被重置)", async () => {
    process.env.DAO_ADVISE_EVERY = "2";
    const sentLog: any[] = [];
    let turn = 0;
    const streamChat = (opts: StreamChatOptions) => {
      sentLog.push([...opts.messages]);
      turn++;
      return (async function* (): AsyncGenerator<never, AssistantMessage> {
        if (turn <= 4) return { role: "assistant", content: "", tool_calls: [{ id: "t" + turn, type: "function", function: { name: "write_file", arguments: "{}" } }] };
        return { role: "assistant", content: "done" };
      })();
    };
    const executeToolCalls = async (tcs: any[]) => tcs.map((tc) => ({ role: "tool", tool_call_id: tc.id, content: "ok" }));
    const s = new Session("SYS", "m");
    s.addUser("go");
    await runTurn(baseDeps(s, streamChat, executeToolCalls));
    delete process.env.DAO_ADVISE_EVERY;
    expect(sentLog.every((m) => !m.some((x: any) => typeof x.content === "string" && x.content.includes("进度提醒")))).toBe(true);
  });
});
