import { describe, it, expect } from "vitest";
import { runRepl } from "./repl.js";
import { Session } from "./session/session.js";

function lineFeeder(lines: string[]) {
  let i = 0;
  return async () => (i < lines.length ? lines[i++]! : null);
}

describe("runRepl", () => {
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
