import { describe, it, expect } from "vitest";
import { runTurn } from "./loop.js";
import { Session } from "../session/session.js";
import { ToolRegistry } from "../tools/registry.js";
import { readFileTool } from "../tools/read_file.js";
import { listDirTool } from "../tools/list_dir.js";

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

  // TS 最常见的隐形缓存杀手:工具定义(zod→JSON schema)逐请求序列化漂移(key 顺序不稳)。
  // 一旦两轮的 tools 字节不同,前缀缓存从工具段起整段失效。这里钉死它字节稳定。
  it("tool definitions serialize byte-identically across turns (no zod/registry drift)", async () => {
    const reg = new ToolRegistry();
    reg.register(readFileTool);
    reg.register(listDirTool);
    const toolsJson: string[] = [];
    const capturing = (opts: any) => {
      toolsJson.push(JSON.stringify(opts.tools ?? null));
      return (async function* () { return { role: "assistant" as const, content: "ok" }; })();
    };
    const s = new Session("SYS", "deepseek-v4-pro");
    const d = { ...deps(s), registry: reg, streamChat: capturing } as any;
    s.addUser("a"); await runTurn(d);
    s.addUser("b"); await runTurn(d);
    expect(toolsJson).toHaveLength(2);
    expect(toolsJson[0]).toBe(toolsJson[1]); // 逐字节相同 → 工具段不破缓存
    expect(toolsJson[0]).toContain("read_file");
  });
});
