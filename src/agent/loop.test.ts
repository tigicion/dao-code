import { describe, it, expect } from "vitest";
import { runTurn } from "./loop.js";
import { Session } from "../session/session.js";
import { ToolRegistry } from "../tools/registry.js";
import { defineTool } from "../tools/types.js";
import { z } from "zod";
import type { AssistantMessage, StreamChatOptions, StreamDelta, ToolMessage } from "../client/types.js";
import type { ApprovalGate } from "../approval/types.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCacheAuditSink } from "../session/cache_audit.js";

const config = { baseUrl: "https://x", apiKey: "sk" };
const ctx = { workspaceRoot: "/tmp" };
const stubGate: ApprovalGate = { decide: () => "allow", requestBatch: async () => new Map() };

function turn(deltas: StreamDelta[], message: AssistantMessage) {
  return async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
    for (const d of deltas) yield d;
    return message;
  };
}
function scripted(turns: Array<() => AsyncGenerator<StreamDelta, AssistantMessage>>) {
  let i = 0;
  return () => turns[i++]!();
}
function emptyReg() {
  return new ToolRegistry();
}

describe("runTurn", () => {
  it("appends the assistant reply to the session when no tools requested", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    await runTurn({
      session: s,
      config,
      registry: emptyReg(),
      ctx,
      gate: stubGate,
      streamChat: scripted([turn([{ kind: "content", text: "hello" }], { role: "assistant", content: "hello" })]),
      executeToolCalls: async () => [],
      write: () => {},
    });
    expect(s.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("空 assistant(无内容无工具)先重试一次;连续两次空才不入库、结束(防下一轮 DeepSeek 400)", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    let calls = 0;
    await runTurn({
      session: s,
      config,
      registry: emptyReg(),
      ctx,
      gate: stubGate,
      streamChat: (() => { calls++; return turn([], { role: "assistant", content: "" })(); }) as any,
      executeToolCalls: async () => [],
      write: () => {},
    });
    expect(calls).toBe(2); // 第一次空响应触发了一次重试,不是立刻放弃
    expect(s.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
    ]); // 两次都空 → 都不入库,结束
  });

  it("空 assistant 重试后拿到真实内容 → 用重试结果,不当成模型主动结束", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    const calls = scripted([
      turn([], { role: "assistant", content: "" }), // 第一次:空(比如陷入未收敛的长推理)
      turn([{ kind: "content", text: "总算想清楚了" }], { role: "assistant", content: "总算想清楚了" }), // 重试:拿到真实结论
    ]);
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: (() => calls()) as any,
      executeToolCalls: async () => [],
      write: () => {},
    });
    expect(s.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "总算想清楚了" },
    ]); // 空响应被丢弃(不入库),重试拿到的真实内容才入库
  });

  it("reasoning 耗尽预算(onEmptyTruncation)→ 重试前注入收敛提示,而非盲目原样重发", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    let call = 0;
    const streamChatMock = ((opts: StreamChatOptions) => {
      call++;
      if (call === 1) {
        opts.onEmptyTruncation?.();
        return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
          return { role: "assistant", content: "" };
        })();
      }
      return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
        yield { kind: "content", text: "收敛后的结论" };
        return { role: "assistant", content: "收敛后的结论" };
      })();
    }) as any;
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: streamChatMock,
      executeToolCalls: async () => [],
      write: () => {},
    });
    expect(call).toBe(2);
    expect(s.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
      {
        role: "system",
        content: "[提示] 上一轮的思考过程用尽了输出预算,还没有给出最终回答或工具调用就被截断。" +
          "这一轮请更快收敛:如果方向已经想清楚,直接给出结论、代码或调用工具,不要重新从头展开完整推导。",
      },
      { role: "assistant", content: "收敛后的结论" },
    ]);
  });

  it("主备模型都遇到网络/超时类异常 → 退避后整轮重试,不让整个episode崩溃退出", async () => {
    // 根因(真实撞见:terminal-bench make-mips-interpreter):模型试图单次write_file写入
    // 千行级大文件,主模型先抛异常触发回退到flash,flash随后也120s空闲超时——此前这里
    // 直接上抛,整个进程崩溃退出(NonZeroAgentExitCodeError exit 1),900s+预算和此前
    // 全部真实进展作废。现在退避后把usedFallback重置、给主模型再来一次机会。
    process.env.DAO_HARD_RETRY_DELAY_MS = "1"; // 测试里不等真实退避时间(0会被||1000兜底,故用1ms)
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    let call = 0;
    const streamChatMock = (() => {
      call++;
      if (call <= 2) {
        // 第1次(主模型)、第2次(回退到flash)都遇到网络/超时类异常
        return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
          throw new Error("模型流空闲超时(120s 未收到数据),已停止本回合");
        })();
      }
      // 第3次:退避重试后回到主模型,这次成功
      return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
        yield { kind: "content", text: "重试后成功了" };
        return { role: "assistant", content: "重试后成功了" };
      })();
    }) as any;
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: streamChatMock,
      fallbackModel: "deepseek-v4-flash",
      executeToolCalls: async () => [],
      write: () => {},
    });
    delete process.env.DAO_HARD_RETRY_DELAY_MS;
    expect(call).toBe(3); // 主模型失败→回退flash失败→退避重试回到主模型成功
    expect(s.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "重试后成功了" },
    ]);
  });

  it("sends session.model and runs tools then loops", async () => {
    const s = new Session("SYS", "deepseek-v4-flash");
    s.addUser("go");
    let sentModel = "";
    const assistantWithTool: AssistantMessage = {
      role: "assistant", content: null,
      tool_calls: [{ id: "c0", type: "function", function: { name: "read_file", arguments: "{}" } }],
    };
    const toolMsgs: ToolMessage[] = [{ role: "tool", tool_call_id: "c0", content: "R" }];
    const calls = scripted([
      turn([], assistantWithTool),
      turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" }),
    ]);
    await runTurn({
      session: s,
      config,
      registry: emptyReg(),
      ctx,
      gate: stubGate,
      streamChat: ((opts: StreamChatOptions) => {
        sentModel = opts.model;
        return calls();
      }) as any,
      executeToolCalls: async () => toolMsgs,
      write: () => {},
    });
    expect(sentModel).toBe("deepseek-v4-flash");
    expect(s.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
  });


  it("§4 轮内主动压缩:shouldCompact=true 时在工具轮之间调 compact(不等回合末)", async () => {
    const s = new Session("SYS", "m");
    s.addUser("go");
    const assistantWithTool: AssistantMessage = {
      role: "assistant", content: null,
      tool_calls: [{ id: "c0", type: "function", function: { name: "read_file", arguments: "{}" } }],
    };
    const calls = scripted([
      turn([], assistantWithTool), // 第0轮:调工具
      turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" }), // 第1轮:收尾
    ]);
    let compactCalls = 0;
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: (() => calls()) as any,
      executeToolCalls: async () => [{ role: "tool", tool_call_id: "c0", content: "R" }],
      write: () => {},
      compact: async () => { compactCalls++; },
      shouldCompact: () => true, // 始终判"接近上限"
    });
    expect(compactCalls).toBe(1); // 第1轮前压一次(t>0),第0轮不压
  });

  it("§4 轮内压缩:shouldCompact=false 时不压", async () => {
    const s = new Session("SYS", "m");
    s.addUser("go");
    const calls = scripted([
      turn([], { role: "assistant", content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "read_file", arguments: "{}" } }] }),
      turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" }),
    ]);
    let compactCalls = 0;
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: (() => calls()) as any,
      executeToolCalls: async () => [{ role: "tool", tool_call_id: "c0", content: "R" }],
      write: () => {},
      compact: async () => { compactCalls++; },
      shouldCompact: () => false,
    });
    expect(compactCalls).toBe(0);
  });

  it("进度提醒【append】进 session(append-only,缓存安全),而非每轮拼到请求尾部", async () => {
    const s = new Session("SYS", "m");
    s.addUser("go");
    // 连续 5 个非推进回合(只读),第 5 个触发进度提醒;第 6 回合收尾。
    const readTurn = () => turn([], { role: "assistant", content: null, tool_calls: [{ id: "r", type: "function", function: { name: "read_file", arguments: "{}" } }] })();
    const turns = [readTurn, readTurn, readTurn, readTurn, readTurn, () => turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" })()];
    let i = 0;
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: (() => turns[i++]!()) as any,
      executeToolCalls: async () => [{ role: "tool", tool_call_id: "r", content: "R" }],
      write: () => {},
      maxTurns: 10,
    });
    // 提醒持久化在历史里(append-only),不是用完即弃的尾部临时注入
    expect(s.messages.some((m) => m.role === "system" && String(m.content).includes("进度提醒"))).toBe(true);
  });

  it("进度提醒触发时同步 events.notice,而不是只悄悄进 session.messages(无用户可见痕迹)", async () => {
    // 根因:之前这条 advisory 只 push 进 session.messages,没有对应的 events.notice 调用——
    // 模型能在下一轮请求里看到提醒,但 dao_stdout.txt/transcript 里完全没有任何痕迹,导致
    // eval 复盘时无法确认这条安全网到底有没有触发过(真实撞见:terminal-bench 3 道题连续
    // 空转 20+ 轮,但 dao_stdout.txt 里一次"进度提醒"都搜不到,一度误判成机制没生效)。
    const s = new Session("SYS", "m");
    s.addUser("go");
    const readTurn = () => turn([], { role: "assistant", content: null, tool_calls: [{ id: "r", type: "function", function: { name: "read_file", arguments: "{}" } }] })();
    const turns = [readTurn, readTurn, readTurn, readTurn, readTurn, () => turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" })()];
    let i = 0;
    const written: string[] = [];
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: (() => turns[i++]!()) as any,
      executeToolCalls: async () => [{ role: "tool", tool_call_id: "r", content: "R" }],
      write: (t) => written.push(t),
      maxTurns: 10,
    });
    expect(written.join("")).toContain("进度提醒");
  });

  it("第1次进度提醒就要带具体动作指令,不能等第2次才给——只陈述状态的提醒拦不住已经在惯性里的模型", async () => {
    // 根因(内省复盘 schemelike-metacircular-eval 反模式#30 时发现):旧版第1次提醒只是
    // "回看todo/不要空转"这种陈述状态的通用措辞,没给具体下一步动作;这道题只触发过1次
    // 提醒就被模型无视、继续空转了几千行才真正动笔——等第2次升级措辞根本没等到,同一次
    // 卡住的窗口已经浪费了。第1次就要直接给"写脚本/跑命令/哪怕写不完整版本也要落地"这条。
    const s = new Session("SYS", "m");
    s.addUser("go");
    const readTurn = () => turn([], { role: "assistant", content: null, tool_calls: [{ id: "r", type: "function", function: { name: "read_file", arguments: "{}" } }] })();
    const turns = [
      ...Array.from({ length: 5 }, () => readTurn),
      () => turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" })(),
    ];
    let i = 0;
    const written: string[] = [];
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: (() => turns[i++]!()) as any,
      executeToolCalls: async () => [{ role: "tool", tool_call_id: "r", content: "R" }],
      write: (t) => written.push(t),
      maxTurns: 15,
    });
    const sys = s.messages.filter((m) => m.role === "system").map((m) => String(m.content));
    const first = sys.find((c) => c.includes("[进度提醒]") && !c.includes("第2次"));
    expect(first).toBeDefined();
    expect(first).toContain("写脚本算出来、跑命令查、或读文档确认"); // 具体动作,不是泛泛的"回看todo"
    expect(first).toContain("哪怕设计还没完全想清楚,也先写一个不完整的最小版本落地"); // 对症内省发现的"写比想更安全"这条
    expect(written.join("")).toContain("进度提醒");
  });

  it("同一次卡住连续两次触发进度提醒 → 第2次强调'已经提醒过仍没推进',同样带具体动作", async () => {
    const s = new Session("SYS", "m");
    s.addUser("go");
    const readTurn = () => turn([], { role: "assistant", content: null, tool_calls: [{ id: "r", type: "function", function: { name: "read_file", arguments: "{}" } }] })();
    // 连续 10 个非推进回合:第5轮触发第1次提醒,第10轮触发第2次(应升级措辞)。
    const turns = [
      ...Array.from({ length: 10 }, () => readTurn),
      () => turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" })(),
    ];
    let i = 0;
    const written: string[] = [];
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: (() => turns[i++]!()) as any,
      executeToolCalls: async () => [{ role: "tool", tool_call_id: "r", content: "R" }],
      write: (t) => written.push(t),
      maxTurns: 15,
    });
    const sys = s.messages.filter((m) => m.role === "system").map((m) => String(m.content));
    expect(sys.some((c) => c.includes("[进度提醒]") && !c.includes("第2次"))).toBe(true); // 第1次
    expect(sys.some((c) => c.includes("[进度提醒·第2次]") && c.includes("前面提醒过") && c.includes("写脚本算出来"))).toBe(true); // 第2次:强调已提醒过
    expect(written.join("")).toContain("进度提醒·第2次");
  });

  it("卡住期间中途真的推进过一次 → 计数清零,后续再卡住重新从通用措辞开始", async () => {
    const s = new Session("SYS", "m");
    s.addUser("go");
    const readTurn = () => turn([], { role: "assistant", content: null, tool_calls: [{ id: "r", type: "function", function: { name: "read_file", arguments: "{}" } }] })();
    const writeTurn = () => turn([], { role: "assistant", content: null, tool_calls: [{ id: "w", type: "function", function: { name: "write_file", arguments: "{}" } }] })();
    // 5轮空转(触发第1次提醒)→ 1轮真实推进(清零)→ 再5轮空转(应该又是"第1次",不是"第2次")。
    const turns = [
      ...Array.from({ length: 5 }, () => readTurn),
      writeTurn,
      ...Array.from({ length: 5 }, () => readTurn),
      () => turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" })(),
    ];
    let i = 0;
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: (() => turns[i++]!()) as any,
      executeToolCalls: async (calls) => calls.map((c) => ({ role: "tool" as const, tool_call_id: c.id, content: "R" })),
      write: () => {},
      maxTurns: 15,
    });
    const sys = s.messages.filter((m) => m.role === "system").map((m) => String(m.content));
    // 两次触发都应该是"第1次"(通用措辞),因为中途的 write_file 把 stuckAdviceCount 清零了。
    expect(sys.filter((c) => c.includes("[进度提醒]") && !c.includes("第")).length).toBe(2);
    expect(sys.some((c) => c.includes("第2次"))).toBe(false);
  });

  it("轮数提醒(接近 maxTurns)触发时同步 events.notice", async () => {
    // 同一处代码块里的另一条 advisory,同一个盲区——一并补上可见提示。
    const s = new Session("SYS", "m");
    s.addUser("go");
    // maxTurns=6 → t===1 时命中 t===maxTurns-5,用推进型工具调用避免同时触发进度提醒混淆断言。
    const writeTurn = () => turn([], { role: "assistant", content: null, tool_calls: [{ id: "w", type: "function", function: { name: "write_file", arguments: "{}" } }] })();
    const turns = [writeTurn, writeTurn, writeTurn, writeTurn, writeTurn, () => turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" })()];
    let i = 0;
    const written: string[] = [];
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: (() => turns[i++]!()) as any,
      executeToolCalls: async () => [{ role: "tool", tool_call_id: "w", content: "W" }],
      write: (t) => written.push(t),
      maxTurns: 6,
    });
    expect(written.join("")).toContain("轮数提醒");
  });

  it("finish_reason=content_filter 时明确提示,不当成普通完成悄悄放过", async () => {
    // 根因(真实撞见):terminal-bench password-recovery/protein-assembly 两个任务命中过
    // 服务端内容过滤拦截——回复被替换成一句通用拒答文案,混在正常回合里完全看不出区别,
    // 当时只能靠事后手工 replay 复现才查出真相。client.ts 已经把 finish_reason 通过
    // onFinishReason 回调透传出来,这里断言 loop.ts 真的接住了并给出可见提示。
    const s = new Session("SYS", "m");
    s.addUser("go");
    const written: string[] = [];
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: ((opts: StreamChatOptions) => {
        opts.onFinishReason?.("content_filter");
        return turn([{ kind: "content", text: "作为一个人工智能语言模型..." }], { role: "assistant", content: "作为一个人工智能语言模型..." })();
      }) as any,
      executeToolCalls: async () => [],
      write: (t) => written.push(t),
    });
    expect(written.join("")).toContain("content_filter");
  });

  it("drainAdvisories:回合边界把结论注入为 system 消息 + 发审视者介入提示", async () => {
    const s = new Session("SYS", "m");
    s.addUser("go");
    let drained = false;
    const out: string[] = [];
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" }) as any,
      executeToolCalls: async () => [],
      write: (sx) => out.push(sx),
      drainAdvisories: () => (drained ? [] : (drained = true, ["[审视者]\n根因可能是 X"])),
    });
    expect(s.messages.some((m) => m.role === "system" && String(m.content).includes("[审视者]"))).toBe(true);
    expect(out.join("")).toContain("审视者介入"); // 注入时给用户可见提示(与失败式挑战者一致)
  });

  it("drainNotifications:回合边界把后台子代理结果注入为 user 消息 + 发提示(修复 headless 后台丢失)", async () => {
    const s = new Session("SYS", "m");
    s.addUser("go");
    let drained = false;
    const out: string[] = [];
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" }) as any,
      executeToolCalls: async () => [],
      write: (sx) => out.push(sx),
      drainNotifications: () => (drained ? [] : (drained = true, ["子代理结论:根因在 executor.rs:721"])),
    });
    // 后台结果作为 user 消息持久化进历史(append-only),供模型当轮接住
    expect(s.messages.some((m) => m.role === "user" && String(m.content).includes("executor.rs:721"))).toBe(true);
    expect(out.join("")).toContain("后台任务结果"); // 注入时给用户可见提示
  });

  it("omits write/exec tools in plan mode", async () => {
    const r = new ToolRegistry();
    r.register(defineTool({ name: "read_file", description: "", capability: "read", approval: "auto", schema: z.object({}), handler: async () => "" }));
    r.register(defineTool({ name: "write_file", description: "", capability: "write", approval: "required", schema: z.object({}), handler: async () => "" }));
    const s = new Session("SYS", "m");
    s.addUser("plan something");
    s.toggleMode();
    let sentTools: string[] | undefined;
    await runTurn({
      session: s,
      config,
      registry: r,
      ctx,
      gate: stubGate,
      streamChat: ((opts: StreamChatOptions) => {
        sentTools = opts.tools?.map((t) => t.function.name);
        return turn([{ kind: "content", text: "ok" }], { role: "assistant", content: "ok" })();
      }) as any,
      executeToolCalls: async () => [],
      write: () => {},
    });
    expect(sentTools).toEqual(["read_file"]);
  });

  it("stops at maxTurns", async () => {
    const s = new Session("SYS", "m");
    s.addUser("loop");
    const looping = () => turn([], { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "x", arguments: "{}" } }] })();
    const written: string[] = [];
    await runTurn({
      session: s,
      config,
      registry: emptyReg(),
      ctx,
      gate: stubGate,
      streamChat: scripted([looping, looping, looping, looping]),
      executeToolCalls: async () => [{ role: "tool", tool_call_id: "c", content: "x" }],
      write: (t) => written.push(t),
      maxTurns: 2,
    });
    expect(written.join("")).toContain("最大轮数");
  });

  it("forwards the signal to streamChat", async () => {
    const s = new Session("SYS", "m");
    s.addUser("hi");
    const controller = new AbortController();
    let sentSignal: AbortSignal | undefined;
    await runTurn({
      session: s,
      config,
      registry: emptyReg(),
      ctx,
      gate: stubGate,
      streamChat: ((opts: StreamChatOptions) => {
        sentSignal = opts.signal;
        return turn([{ kind: "content", text: "ok" }], { role: "assistant", content: "ok" })();
      }) as any,
      executeToolCalls: async () => [],
      write: () => {},
      signal: controller.signal,
    });
    expect(sentSignal).toBe(controller.signal);
  });

  it("aborted after assistant(tool_calls): 不执行工具,但补齐 tool 结果不留悬空(防下一轮 DeepSeek 400)", async () => {
    const s = new Session("SYS", "m");
    s.addUser("go");
    const controller = new AbortController();
    let executed = 0;
    // 模拟:模型答完(带 tool_calls)随即用户 abort —— 工具尚未执行。
    const partialWithTool: AssistantMessage = {
      role: "assistant", content: "partial",
      tool_calls: [{ id: "c0", type: "function", function: { name: "read_file", arguments: "{}" } }],
    };
    await runTurn({
      session: s,
      config,
      registry: emptyReg(),
      ctx,
      gate: stubGate,
      streamChat: (() =>
        (async function* () {
          controller.abort();
          return partialWithTool;
        })()) as any,
      executeToolCalls: (async (cs: any) => { executed += cs.length; return []; }) as any,
      write: () => {},
      signal: controller.signal,
    });
    expect(executed).toBe(0); // abort 后不执行工具
    expect(s.messages.at(-2)).toEqual(partialWithTool); // 部分回复已入库
    const last = s.messages.at(-1) as ToolMessage; // 紧跟一条取消用 tool 结果
    expect(last.role).toBe("tool");
    expect(last.tool_call_id).toBe("c0");
    // 不变式:每个 assistant 的 tool_call 都有对应 tool 结果,历史可合法再发给 API。
    const wanted = s.messages.filter((m) => m.role === "assistant").flatMap((m) => (m as AssistantMessage).tool_calls ?? []).map((tc) => tc.id);
    const answered = new Set(s.messages.filter((m) => m.role === "tool").map((m) => (m as ToolMessage).tool_call_id));
    expect(wanted.every((id) => answered.has(id))).toBe(true);
  });

  it("returns immediately without calling streamChat when already aborted", async () => {
    const s = new Session("SYS", "m");
    s.addUser("hi");
    const controller = new AbortController();
    controller.abort();
    let called = 0;
    await runTurn({
      session: s,
      config,
      registry: emptyReg(),
      ctx,
      gate: stubGate,
      streamChat: (() => { called++; return turn([], { role: "assistant", content: "x" })(); }) as any,
      executeToolCalls: async () => [],
      write: () => {},
      signal: controller.signal,
    });
    expect(called).toBe(0);
  });

  it("blocks write/exec tool calls at execution in plan mode (does not dispatch them)", async () => {
    const r = new ToolRegistry();
    r.register(defineTool({ name: "read_file", description: "", capability: "read", approval: "auto", schema: z.object({}), handler: async () => "" }));
    r.register(defineTool({ name: "write_file", description: "", capability: "write", approval: "required", schema: z.object({}), handler: async () => "" }));
    const s = new Session("SYS", "m");
    s.addUser("create a file");
    s.toggleMode(); // → plan
    let executedCalls = 0;
    const calls = scripted([
      turn([], { role: "assistant", content: null, tool_calls: [{ id: "w0", type: "function", function: { name: "write_file", arguments: "{}" } }] }),
      turn([{ kind: "content", text: "can't in plan" }], { role: "assistant", content: "can't in plan" }),
    ]);
    await runTurn({
      session: s,
      config,
      registry: r,
      ctx,
      gate: stubGate,
      streamChat: () => calls(),
      executeToolCalls: (async (cs: any) => { executedCalls += cs.length; return cs.map((c: any) => ({ role: "tool", tool_call_id: c.id, content: "RAN" })); }) as any,
      write: () => {},
    });
    expect(executedCalls).toBe(0); // write_file never dispatched in plan
    const toolMsg = s.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("不可用");
  });

  it("runTurn records a cache-audit event via the injected sink", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loop-ca-"));
    const sink = createCacheAuditSink(dir, {});
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    await runTurn({
      session: s,
      config,
      registry: emptyReg(),
      ctx,
      gate: stubGate,
      streamChat: ((opts: StreamChatOptions) => {
        opts.onUsage?.({ prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_cache_hit_tokens: 90, prompt_cache_miss_tokens: 10 });
        return turn([{ kind: "content", text: "hello" }], { role: "assistant", content: "hello" })();
      }) as any,
      executeToolCalls: async () => [],
      write: () => {},
      auditSink: sink,
      auditId: { agent: "main", depth: 0 },
    });
    const lines = readFileSync(path.join(dir, "cache.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(lines[0]!).agent).toBe("main");
  });

  // #3 子代理自挑战:不传 reflect(=子代理),仅 selfChallenge。同错连发 → 确定性检测 → 注入静态自省 nudge。
  it("selfChallenge:同错复发触发自省 nudge(不 fork)", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("go");
    const toolCall = (id: string): AssistantMessage => ({
      role: "assistant", content: null,
      tool_calls: [{ id, type: "function", function: { name: "exec_shell", arguments: "{}" } }],
    });
    const calls = scripted([
      turn([], toolCall("c0")),
      turn([], toolCall("c1")),
      turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" }),
    ]);
    let round = 0;
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: (() => calls()) as any,
      executeToolCalls: async () => {
        round++;
        return [{ role: "tool", tool_call_id: round === 1 ? "c0" : "c1", content: "Error: 同一个错反复出现" }];
      },
      write: () => {},
      selfChallenge: true,
    });
    const sys = s.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    expect(sys).toContain("[自检·必读]");
  });

  it("selfChallenge:全程无失败 → 不注入 nudge", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("go");
    const calls = scripted([
      turn([], { role: "assistant", content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "read_file", arguments: "{}" } }] }),
      turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" }),
    ]);
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: (() => calls()) as any,
      executeToolCalls: async () => [{ role: "tool", tool_call_id: "c0", content: "OK 成功" }],
      write: () => {},
      selfChallenge: true,
    });
    const sys = s.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    expect(sys).not.toContain("[自检·必读]");
  });

  function regWithVerifyDone() {
    const r = new ToolRegistry();
    r.register(defineTool({
      name: "write_file", description: "d", descriptionEn: "d", capability: "write", approval: "auto",
      schema: z.object({}), handler: async () => "",
    }));
    r.register(defineTool({
      name: "verify_done", description: "d", descriptionEn: "d", capability: "read", approval: "auto",
      schema: z.object({}), handler: async () => "",
    }));
    return r;
  }

  it("L4.5:碰过代码却从没调用 verify_done → 收尾前注入提醒,不立即结束、再给一轮", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("go");
    const writeCall: AssistantMessage = {
      role: "assistant", content: null,
      tool_calls: [{ id: "c0", type: "function", function: { name: "write_file", arguments: "{}" } }],
    };
    const calls = scripted([
      turn([], writeCall), // 第0轮:写文件
      turn([{ kind: "content", text: "完成了" }], { role: "assistant", content: "完成了" }), // 第1轮:以为可以收尾了
      turn([{ kind: "content", text: "好的,我验证过了" }], { role: "assistant", content: "好的,我验证过了" }), // 第2轮:回应提醒后真正收尾
    ]);
    let turnsRun = 0;
    await runTurn({
      session: s, config, registry: regWithVerifyDone(), ctx, gate: stubGate,
      streamChat: (() => { turnsRun++; return calls(); }) as any,
      executeToolCalls: async () => [{ role: "tool", tool_call_id: "c0", content: "OK" }],
      write: () => {},
      maxTurns: 10,
    });
    expect(turnsRun).toBe(3); // 第1轮的"完成了"没有直接结束循环,消耗了一轮预算追问
    const sys = s.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    expect(sys).toContain("[收尾前检查]");
    expect(sys).toContain("verify_done");
  });

  it("L4.5:调用过 verify_done → 不注入收尾前提醒,正常一轮收尾", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("go");
    const writeCall: AssistantMessage = {
      role: "assistant", content: null,
      tool_calls: [{ id: "c0", type: "function", function: { name: "write_file", arguments: "{}" } }],
    };
    const verifyCall: AssistantMessage = {
      role: "assistant", content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "verify_done", arguments: "{}" } }],
    };
    const calls = scripted([
      turn([], writeCall),
      turn([], verifyCall),
      turn([{ kind: "content", text: "完成了,已验证" }], { role: "assistant", content: "完成了,已验证" }),
    ]);
    let round = 0;
    await runTurn({
      session: s, config, registry: regWithVerifyDone(), ctx, gate: stubGate,
      streamChat: (() => calls()) as any,
      executeToolCalls: async () => {
        round++;
        return [{ role: "tool", tool_call_id: round === 1 ? "c0" : "c1", content: "OK" }];
      },
      write: () => {},
      maxTurns: 10,
    });
    const sys = s.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    expect(sys).not.toContain("[收尾前检查]");
  });
});
