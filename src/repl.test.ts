import { describe, it, expect } from "vitest";
import { runRepl } from "./repl.js";
import { Session } from "./session/session.js";

function lineFeeder(lines: string[]) {
  let i = 0;
  return async () => (i < lines.length ? lines[i++]! : null);
}

describe("runRepl", () => {
  it("真实用户消息触发 onUserMessage(斜杠命令不触发)", async () => {
    const got: string[] = [];
    await runRepl({
      session: new Session("SYS", "m"),
      readLine: lineFeeder(["/help", "画面没显示", "/exit"]),
      runTurn: async () => {},
      compact: async () => {},
      write: () => {},
      onUserMessage: (t) => got.push(t),
    });
    expect(got).toEqual(["画面没显示"]);
  });

  it("runs a turn for plain input and handles a command, then exits on /exit", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    const turns: string[] = [];
    const written: string[] = [];
    await runRepl({
      session: s,
      readLine: lineFeeder(["hello", "/plan", "/exit"]),
      runTurn: async () => { turns.push(s.messages[s.messages.length - 1]!.content as string); },
      compact: async () => {},
      write: (t) => written.push(t),
    });
    expect(turns).toEqual(["hello"]);
    expect(s.mode).toBe("plan");
    expect(written.join("")).toContain("plan 模式");
  });

  it("stops at EOF (readLine returns null)", async () => {
    const s = new Session("SYS", "m");
    let turnCount = 0;
    await runRepl({
      session: s,
      readLine: lineFeeder(["hi"]),
      runTurn: async () => { turnCount++; },
      compact: async () => {},
      write: () => {},
    });
    expect(turnCount).toBe(1);
  });

  it("ignores blank lines", async () => {
    const s = new Session("SYS", "m");
    let turnCount = 0;
    await runRepl({
      session: s,
      readLine: lineFeeder(["   ", "hi"]),
      runTurn: async () => { turnCount++; },
      compact: async () => {},
      write: () => {},
    });
    expect(turnCount).toBe(1);
  });

  it("gateUserPrompt blocked → 跳过该回合,不入对话", async () => {
    const s = new Session("SYS", "m");
    let turnCount = 0;
    const written: string[] = [];
    await runRepl({
      session: s,
      readLine: lineFeeder(["bad", "/exit"]),
      runTurn: async () => { turnCount++; },
      compact: async () => {},
      write: (t) => written.push(t),
      gateUserPrompt: async () => ({ blocked: true, reason: "拒绝" }),
    });
    expect(turnCount).toBe(0); // 被拦,没跑回合
    expect(s.messages.some((m) => m.role === "user")).toBe(false); // 没入对话
    expect(written.join("")).toContain("被 hook 阻止");
  });

  it("gateUserPrompt additionalContext → 入回合且注入上下文", async () => {
    const s = new Session("SYS", "m");
    let turnCount = 0;
    await runRepl({
      session: s,
      readLine: lineFeeder(["hi", "/exit"]),
      runTurn: async () => { turnCount++; },
      compact: async () => {},
      write: () => {},
      gateUserPrompt: async () => ({ blocked: false, additionalContext: "额外上下文" }),
    });
    expect(turnCount).toBe(1);
    expect(s.messages.some((m) => m.role === "user" && m.content === "hi")).toBe(true);
    expect(s.messages.some((m) => m.role === "system" && typeof m.content === "string" && m.content.includes("额外上下文"))).toBe(true);
  });

  it("invokes compact on /compact", async () => {
    const s = new Session("SYS", "m");
    let compacted = 0;
    await runRepl({
      session: s,
      readLine: lineFeeder(["/compact", "/exit"]),
      runTurn: async () => {},
      compact: async () => { compacted++; },
      write: () => {},
    });
    expect(compacted).toBe(1);
  });
});

describe("runRepl 后台通知回合边界自动续跑", () => {
  it("一回合后有通知 → 自动再跑一回合喂通知;之后无通知则停", async () => {
    const turns: string[] = [];
    const session: any = { addUser: (t: string) => turns.push(t), messages: [] };
    const lines: (string | null)[] = ["第一条输入", null]; // 一条真实输入后 EOF
    const notesBatches: string[][] = [["<task-message>进度</task-message>"], []]; // 第一次 drain 有一条,第二次空
    await runRepl({
      session,
      readLine: async () => lines.shift() ?? null,
      runTurn: async () => { /* no-op turn */ },
      compact: async () => {},
      write: () => {},
      drainNotifications: () => notesBatches.shift() ?? [],
    } as any);
    // 期望:用户输入入一回合 + 通知自动续一回合
    expect(turns.some((t) => t.includes("第一条输入"))).toBe(true);
    expect(turns.some((t) => t.includes("进度"))).toBe(true);
  });
  it("无 drainNotifications(或始终空)→ 行为不变(不额外跑回合)", async () => {
    const turns: string[] = [];
    const session: any = { addUser: (t: string) => turns.push(t), messages: [] };
    const lines: (string | null)[] = ["only", null];
    await runRepl({
      session,
      readLine: async () => lines.shift() ?? null,
      runTurn: async () => {},
      compact: async () => {},
      write: () => {},
    } as any); // 不传 drainNotifications
    expect(turns).toEqual(["only"]); // 仅一条,无自动续
  });
});
