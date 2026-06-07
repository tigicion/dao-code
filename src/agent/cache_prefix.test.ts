import { describe, it, expect } from "vitest";
import { runTurn } from "./loop.js";
import { Session } from "../session/session.js";
import { ToolRegistry } from "../tools/registry.js";

// 缓存纪律的回归:runTurn 只能往 messages 尾部【追加】,绝不改写/重排已有前缀——
// 任何前缀变动都会从分歧点起整段 bust DeepSeek prefix cache(命中价比未命中便宜约 98%)。

// 不调工具的假 streamChat:一轮即返回。
const noToolStream = () =>
  (async function* () {
    return { role: "assistant" as const, content: "ok" };
  })();

function deps(session: Session) {
  return {
    session,
    config: { baseUrl: "x", apiKey: "x" },
    registry: new ToolRegistry(),
    ctx: { workspaceRoot: "/tmp", readFiles: new Set<string>() },
    gate: { needsApproval: () => false, requestBatch: async () => new Map() },
    streamChat: noToolStream,
    executeToolCalls: async () => [],
    write: () => {},
  } as any;
}

describe("prefix append-only invariant", () => {
  it("runTurn appends only; the existing prefix stays byte-identical across turns", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hello");
    const prefix1 = JSON.stringify(s.messages); // [system, user]

    await runTurn(deps(s));
    // 前缀(system+user)逐字节不变,只在尾部追加了 assistant
    expect(JSON.stringify(s.messages.slice(0, 2))).toBe(prefix1);
    expect(s.messages.length).toBe(3);
    expect(s.messages[2]).toMatchObject({ role: "assistant" });

    // 第二轮:再追加用户+助手,前 3 条仍逐字节不变
    const prefix2 = JSON.stringify(s.messages);
    s.addUser("again");
    await runTurn(deps(s));
    expect(JSON.stringify(s.messages.slice(0, 3))).toBe(prefix2);
    expect(s.messages.length).toBe(5);
  });

  it("system message (cache anchor) is never mutated by a turn", async () => {
    const s = new Session("SYS-ANCHOR", "m");
    s.addUser("q");
    await runTurn(deps(s));
    expect(s.messages[0]).toEqual({ role: "system", content: "SYS-ANCHOR" });
  });
});
