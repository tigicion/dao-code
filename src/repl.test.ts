import { describe, it, expect } from "vitest";
import { runRepl, drainAndContinue } from "./repl.js";
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

describe("drainAndContinue 等待仍在跑的后台进程(不提前退出)", () => {
  it("暂无通知但仍有后台进程在跑 → 轮询等待,直到通知到达再续跑一回合", async () => {
    const turns: string[] = [];
    const session: any = { addUser: (t: string) => turns.push(t) };
    // 前两次 drain 都是空的(后台还没退出),第三次才有通知;配合 runningBackgroundCount
    // 前两次报告"还有1个在跑",通知到达那次报告"跑完了,0个"。
    const notesBatches: string[][] = [[], [], ["<task-notification>后台命令完成</task-notification>"]];
    const runningCounts = [1, 1, 0];
    const sleeps: number[] = [];
    let runTurnCalls = 0;
    await drainAndContinue({
      session,
      write: () => {},
      runTurn: async () => { runTurnCalls++; },
      drainNotifications: () => notesBatches.shift() ?? [],
      runningBackgroundCount: () => runningCounts.shift() ?? 0,
      sleep: async (ms: number) => { sleeps.push(ms); },
    } as any);
    expect(sleeps.length).toBe(2); // 前两次空转各等了一次
    expect(runTurnCalls).toBe(1); // 通知到达后续跑了一回合
    expect(turns.some((t) => t.includes("后台命令完成"))).toBe(true);
  });

  it("暂无通知且没有后台进程在跑 → 立即返回,不会挂起等待", async () => {
    const sleeps: number[] = [];
    let runTurnCalls = 0;
    await drainAndContinue({
      session: { addUser: () => {} } as any,
      write: () => {},
      runTurn: async () => { runTurnCalls++; },
      drainNotifications: () => [],
      runningBackgroundCount: () => 0,
      sleep: async (ms: number) => { sleeps.push(ms); },
    } as any);
    expect(sleeps).toEqual([]);
    expect(runTurnCalls).toBe(0);
  });

  it("不传 runningBackgroundCount → 行为同旧版(空通知直接返回,不等待)", async () => {
    const sleeps: number[] = [];
    await drainAndContinue({
      session: { addUser: () => {} } as any,
      write: () => {},
      runTurn: async () => {},
      drainNotifications: () => [],
      sleep: async (ms: number) => { sleeps.push(ms); },
    } as any);
    expect(sleeps).toEqual([]); // 没有 runningBackgroundCount 就不等,维持旧行为
  });
});

describe("drainAndContinue 提供 waitForBackgroundChange → 事件驱动等待,不轮询", () => {
  it("有 waitForBackgroundChange → 优先用它等,完全不调用 sleep", async () => {
    const turns: string[] = [];
    const session: any = { addUser: (t: string) => turns.push(t) };
    const notesBatches: string[][] = [[], ["<task-notification>装好了</task-notification>"]];
    const runningCounts = [1, 0];
    const sleeps: number[] = [];
    let waitCalls = 0;
    let runTurnCalls = 0;
    await drainAndContinue({
      session,
      write: () => {},
      runTurn: async () => { runTurnCalls++; },
      drainNotifications: () => notesBatches.shift() ?? [],
      runningBackgroundCount: () => runningCounts.shift() ?? 0,
      waitForBackgroundChange: async () => { waitCalls++; },
      sleep: async (ms: number) => { sleeps.push(ms); }, // 提供了也不该被用到
    } as any);
    expect(waitCalls).toBe(1); // 空转那一次改用事件等待
    expect(sleeps).toEqual([]); // 完全没有走轮询分支
    expect(runTurnCalls).toBe(1);
    expect(turns.some((t) => t.includes("装好了"))).toBe(true);
  });

  it("waitForBackgroundChange 在 drainNotifications 已经读到通知之前 resolve → 不会漏读(下一轮循环顶部照常先查队列)", async () => {
    // 模拟真实场景里"检测(事件驱动,零延迟)"和"取件(下一轮循环顶部)"分离:
    // waitForBackgroundChange resolve 后,循环回到顶部,drainNotifications 这时才吐出结果。
    const session: any = { addUser: () => {} };
    const notesBatches: string[][] = [[], ["<task-notification>done</task-notification>"]];
    const runningCounts = [1, 0];
    let runTurnCalls = 0;
    await drainAndContinue({
      session,
      write: () => {},
      runTurn: async () => { runTurnCalls++; },
      drainNotifications: () => notesBatches.shift() ?? [],
      runningBackgroundCount: () => runningCounts.shift() ?? 0,
      waitForBackgroundChange: async () => {}, // 立即 resolve,模拟"变化已经发生"
    } as any);
    expect(runTurnCalls).toBe(1); // 没有卡住/漏读,正常续跑了
  });
});
