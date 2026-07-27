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
    progressAdvice: true,
  } as any;
}

describe("L4.2/L4.3 advisor", () => {
  it("连续空转 N 轮后,进度提醒【持久 append 进会话】(下一轮请求带上;缓存安全)", async () => {
    process.env.DAO_ADVISE_GAPS = "2,2,2";
    const sentLog: any[] = [];
    let turn = 0;
    const streamChat = (opts: StreamChatOptions) => {
      sentLog.push([...opts.messages]);
      turn++;
      return (async function* (): AsyncGenerator<never, AssistantMessage> {
        if (turn <= 3) return { role: "assistant", content: "", tool_calls: [{ id: "t" + turn, type: "function", function: { name: "Read", arguments: "{}" } }] };
        return { role: "assistant", content: "done" };
      })();
    };
    const executeToolCalls = async (tcs: any[]) => tcs.map((tc) => ({ role: "tool", tool_call_id: tc.id, content: "ok" }));
    const s = new Session("SYS", "m");
    s.addUser("go");
    await runTurn(baseDeps(s, streamChat, executeToolCalls));
    delete process.env.DAO_ADVISE_GAPS;

    const advisoryIn = (msgs: any[]) => msgs.some((m) => typeof m.content === "string" && m.content.includes("进度提醒"));
    expect(advisoryIn(sentLog[0])).toBe(false); // 第1次:还没空转
    expect(advisoryIn(sentLog[2])).toBe(true); // 第3次:已空转2轮 → 上一轮末已 append 提醒,本轮请求带上
    // 提醒【持久写回 session】(append-only,缓存安全),而非用完即弃的尾部临时注入
    expect(s.messages.some((m) => typeof m.content === "string" && m.content.includes("进度提醒"))).toBe(true);
  });

  it("有文件改动则不提醒(进度被重置)", async () => {
    process.env.DAO_ADVISE_GAPS = "2,2,2";
    const sentLog: any[] = [];
    let turn = 0;
    const streamChat = (opts: StreamChatOptions) => {
      sentLog.push([...opts.messages]);
      turn++;
      return (async function* (): AsyncGenerator<never, AssistantMessage> {
        if (turn <= 4) return { role: "assistant", content: "", tool_calls: [{ id: "t" + turn, type: "function", function: { name: "Write", arguments: "{}" } }] };
        return { role: "assistant", content: "done" };
      })();
    };
    const executeToolCalls = async (tcs: any[]) => tcs.map((tc) => ({ role: "tool", tool_call_id: tc.id, content: "ok" }));
    const s = new Session("SYS", "m");
    s.addUser("go");
    await runTurn(baseDeps(s, streamChat, executeToolCalls));
    delete process.env.DAO_ADVISE_GAPS;
    expect(sentLog.every((m) => !m.some((x: any) => typeof x.content === "string" && x.content.includes("进度提醒")))).toBe(true);
  });

  it("Bash 执行也算实质推进——shell heredoc 写文件是真实产出,不该被判成空转", async () => {
    // 根因(2026-07-27 path-tracing 真实 trace):PROGRESS_TOOLS 只认四类写文件工具,
    // 而模型这一整轮都在用 `cat > file <<EOF` 走 Bash 落盘——43 次工具调用里被计为
    // "有推进"的是 0 次,交付物写了两次、还有 6 个脚本,检测器却全程认为它在空转。
    // 提醒文案本身要求的就是"写脚本算出来、跑命令查",不把跑命令计入等于自相矛盾。
    process.env.DAO_ADVISE_GAPS = "2,2,2";
    const sentLog: any[] = [];
    let turn = 0;
    const streamChat = (opts: StreamChatOptions) => {
      sentLog.push([...opts.messages]);
      turn++;
      return (async function* (): AsyncGenerator<never, AssistantMessage> {
        if (turn <= 4) return { role: "assistant", content: "", tool_calls: [{ id: "t" + turn, type: "function", function: { name: "Bash", arguments: "{}" } }] };
        return { role: "assistant", content: "done" };
      })();
    };
    const executeToolCalls = async (tcs: any[]) => tcs.map((tc) => ({ role: "tool", tool_call_id: tc.id, content: "ok" }));
    const s = new Session("SYS", "m");
    s.addUser("go");
    await runTurn(baseDeps(s, streamChat, executeToolCalls));
    delete process.env.DAO_ADVISE_GAPS;
    expect(sentLog.every((m) => !m.some((x: any) => typeof x.content === "string" && x.content.includes("进度提醒")))).toBe(true);
  });

  it("TodoWrite 不算实质推进——纯记账的元动作不能把「卡住」计数器清零", async () => {
    // 同一个结构缺陷的另一面:计数器此前把 TodoWrite 当成推进,于是一个只更新任务清单、
    // 不产出任何东西的回合就能把提醒压下去——和"强制工具调用被 Skill(make-plan) 兑现"
    // 是同一类漏洞(用元动作满足判据)。
    process.env.DAO_ADVISE_GAPS = "2,2,2";
    const sentLog: any[] = [];
    let turn = 0;
    const streamChat = (opts: StreamChatOptions) => {
      sentLog.push([...opts.messages]);
      turn++;
      return (async function* (): AsyncGenerator<never, AssistantMessage> {
        if (turn <= 3) return { role: "assistant", content: "", tool_calls: [{ id: "t" + turn, type: "function", function: { name: "TodoWrite", arguments: "{}" } }] };
        return { role: "assistant", content: "done" };
      })();
    };
    const executeToolCalls = async (tcs: any[]) => tcs.map((tc) => ({ role: "tool", tool_call_id: tc.id, content: "ok" }));
    const s = new Session("SYS", "m");
    s.addUser("go");
    await runTurn(baseDeps(s, streamChat, executeToolCalls));
    delete process.env.DAO_ADVISE_GAPS;
    expect(s.messages.some((m) => typeof m.content === "string" && m.content.includes("进度提醒"))).toBe(true);
  });

  it("三档提醒间隔递减:第1次等5轮,第2次再等4轮(累计9),第3次起再等3轮(累计12/15…)", async () => {
    const sentLog: any[] = [];
    let turn = 0;
    // 20轮全部不触碰 PROGRESS_TOOLS(用 Read 占位),让 noProgress 一路累积到 15+
    const streamChat = (opts: StreamChatOptions) => {
      sentLog.push([...opts.messages]);
      turn++;
      return (async function* (): AsyncGenerator<never, AssistantMessage> {
        if (turn <= 16) return { role: "assistant", content: "", tool_calls: [{ id: "t" + turn, type: "function", function: { name: "Read", arguments: "{}" } }] };
        return { role: "assistant", content: "done" };
      })();
    };
    const executeToolCalls = async (tcs: any[]) => tcs.map((tc) => ({ role: "tool", tool_call_id: tc.id, content: "ok" }));
    const s = new Session("SYS", "m");
    s.addUser("go");
    await runTurn(baseDeps(s, streamChat, executeToolCalls));

    // 请求 i 携带的是"上一轮结束时已经 append 的提醒"——所以 noProgress=5 那轮结束后 append 的
    // 提醒,出现在下一次(第6次)请求里(sentLog 下标从0开始,故为 sentLog[5])。
    const totalAdvisoriesBySent = (i: number) => (sentLog[i] as any[]).filter((m) => typeof m.content === "string" && m.content.startsWith("[进度提醒")).length;
    expect(totalAdvisoriesBySent(5)).toBe(1); // 第5轮末触发第1次(累计阈值5)
    expect(totalAdvisoriesBySent(9)).toBe(2); // 第9轮末触发第2次(5+4)
    expect(totalAdvisoriesBySent(12)).toBe(3); // 第12轮末触发第3次(9+3)
    expect(totalAdvisoriesBySent(15)).toBe(4); // 第15轮末触发第4次(12+3,此后维持3的间隔)
  });

  it("headless(interactive: false)时,提醒不建议 AskUserQuestion,改成按判断继续+汇报", async () => {
    process.env.DAO_ADVISE_GAPS = "2,2,2";
    const sentLog: any[] = [];
    let turn = 0;
    const streamChat = (opts: StreamChatOptions) => {
      sentLog.push([...opts.messages]);
      turn++;
      return (async function* (): AsyncGenerator<never, AssistantMessage> {
        if (turn <= 3) return { role: "assistant", content: "", tool_calls: [{ id: "t" + turn, type: "function", function: { name: "Read", arguments: "{}" } }] };
        return { role: "assistant", content: "done" };
      })();
    };
    const executeToolCalls = async (tcs: any[]) => tcs.map((tc) => ({ role: "tool", tool_call_id: tc.id, content: "ok" }));
    const s = new Session("SYS", "m");
    s.addUser("go");
    await runTurn({ ...baseDeps(s, streamChat, executeToolCalls), interactive: false });
    delete process.env.DAO_ADVISE_GAPS;

    const advisory = s.messages.find((m) => typeof m.content === "string" && m.content.includes("进度提醒"));
    expect(advisory).toBeTruthy();
    expect((advisory!.content as string).includes("AskUserQuestion")).toBe(false);
    expect((advisory!.content as string).includes("按你此刻最合理的判断继续推进")).toBe(true);
  });

  it("interactive 省略(默认交互态)时,提醒仍建议 AskUserQuestion(不改变既有交互态字节)", async () => {
    process.env.DAO_ADVISE_GAPS = "2,2,2";
    const sentLog: any[] = [];
    let turn = 0;
    const streamChat = (opts: StreamChatOptions) => {
      sentLog.push([...opts.messages]);
      turn++;
      return (async function* (): AsyncGenerator<never, AssistantMessage> {
        if (turn <= 3) return { role: "assistant", content: "", tool_calls: [{ id: "t" + turn, type: "function", function: { name: "Read", arguments: "{}" } }] };
        return { role: "assistant", content: "done" };
      })();
    };
    const executeToolCalls = async (tcs: any[]) => tcs.map((tc) => ({ role: "tool", tool_call_id: tc.id, content: "ok" }));
    const s = new Session("SYS", "m");
    s.addUser("go");
    await runTurn(baseDeps(s, streamChat, executeToolCalls));
    delete process.env.DAO_ADVISE_GAPS;

    const advisory = s.messages.find((m) => typeof m.content === "string" && m.content.includes("进度提醒"));
    expect(advisory).toBeTruthy();
    expect((advisory!.content as string).includes("用 AskUserQuestion 向用户求助")).toBe(true);
  });
});
