import { describe, it, expect } from "vitest";
import { runTurn, sanitizeHistoryForResume } from "./loop.js";
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
const stubGate: ApprovalGate = { decide: () => "allow", decideAsync: async () => "allow", requestBatch: async () => new Map() };

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
          "这一轮的回复第一步必须是一次工具调用,不允许先输出任何推导性自由文本——" +
          "如果是在反复心算/手工推导同一类计算(坐标偏移、字节位置、进制换算等)," +
          "直接调用 Bash 或 Write 写一个一次性程序把它跑出来,不要在文字里重新推一遍。" +
          "惯用的脚本语言(如 python)如果在这个环境里不可用,换一种环境里确实存在的" +
          "语言/编译器(node、perl、awk,或任务本身已保证存在的编译器如 gcc/cc)写," +
          "目标是自动化而不是固定某一种语言。",
      },
      { role: "assistant", content: "收敛后的结论" },
    ]);
  });

  it("reasoning 耗尽预算(onEmptyTruncation)→ 重试调低 reasoning_effort,但【不再】压低 max_tokens", async () => {
    // 根因链条(2026-07-19 regex-chess 真实复测坐实,逐层递进):
    // 候选(a)——收敛提示改成结构性约束("第一步必须是工具调用")——单独复测仍然复现:
    // 提示确实注入了,但重试请求同样把预算耗在 reasoning 阶段的心算推导上,再次空响应。
    // 候选(b)——单独调低 reasoning_effort 到"low"——复测(regex-chess__wEqpsZA)同样
    // reward=0:cache.jsonl 显示两次调用(默认档/"low"档)completion 字段完全相同,都
    // 精确撞满 max_tokens 上限(16001)。但一次性探测脚本(裸调 ARK,同一 prompt 对比
    // max/low)证实"low"在正常场景下确实会让模型更早收敛(completion 从16001→8660,
    // finish_reason 从 length→stop)——说明 reasoning_effort 不是无效参数,只是遇到
    // 已经陷入具体反复重算循环的强反模式时会被压过去,是"目标预算"而非硬上限。
    // 候选(c)当时的做法是再叠一道远小于会话默认(16000)的硬 max_tokens(6000)。
    // 2026-07-27 复盘推翻了这一档:上面这段注释自己记录的探测值就是"low 档自然收敛在
    // 8660",而 6000 比它还小——等于保证这次重试也会被截断,是自我实现的失败。改成
    // 第一档不压预算(走会话默认),靠 API 层 tool_choice 强制吐出工具调用来阻断螺旋,
    // 而不是靠把腾挪空间压得更死。
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    let call = 0;
    const effortSeen: unknown[] = [];
    const maxTokensSeen: unknown[] = [];
    const streamChatMock = ((opts: StreamChatOptions) => {
      call++;
      effortSeen.push((opts.extra as { reasoning_effort?: unknown } | undefined)?.reasoning_effort);
      maxTokensSeen.push(opts.maxTokens);
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
    expect(effortSeen[0]).toBe("max"); // 首次请求:默认档位,不受影响
    expect(effortSeen[1]).toBe("low"); // onEmptyTruncation 触发后的重试:物理压低
    expect(maxTokensSeen[0]).toBeUndefined(); // 首次请求:不设覆盖,走会话默认上限
    expect(maxTokensSeen[1]).toBeUndefined(); // 重试第一档:不再压低预算(见上方注释)
  });

  it("预算耗尽重试:API 层强制工具调用(tool_choice=required),候选工具收敛为能产出/执行的那几个", async () => {
    // 根因(2026-07-27 feal-differential-cryptanalysis 真实 trace):候选(a)那条"第一步
    // 必须是工具调用"是【文字】约束,管不住 reasoning 阶段。且同一份 trace 里,模型在撞
    // 上限之前(不是作为对这条重试提示的反应)调用过 Skill(make-plan) 这类不产出任何
    // 东西的元工具——说明"愿意先调用工具"不等于"调用的是能真正推进任务的工具",文字
    // 管不了后者。tool_choice 是 API 层唯一硬遵守的约束,但它只保证前者,工具集还要
    // 同时收敛才能保证后者。
    // 工具集同时收敛为"能写盘/能执行"那几个:此刻的状态按定义就是"整个输出预算烧在推理上
    // 却没动手",缺的不是信息是动作。Bash 在功能上已经涵盖读文件/搜索(cat/grep/ls),所以
    // 排除 Read/Grep/Glob 并不剥夺查看能力,只是要求这个动作走一条同时也能产出东西的通道。
    const r = new ToolRegistry();
    for (const [n, cap] of [["Read", "read"], ["Grep", "read"], ["Skill", "read"],
      ["TodoWrite", "write"], ["Write", "write"], ["Bash", "exec"]] as const) {
      r.register(defineTool({ name: n, description: "", capability: cap, approval: "auto", schema: z.object({}), handler: async () => "" }));
    }
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    let call = 0;
    const choiceSeen: unknown[] = [];
    const toolsSeen: string[][] = [];
    const streamChatMock = ((opts: StreamChatOptions) => {
      call++;
      choiceSeen.push((opts.extra as { tool_choice?: unknown } | undefined)?.tool_choice);
      toolsSeen.push((opts.tools ?? []).map((t) => t.function.name));
      if (call === 1) {
        opts.onEmptyTruncation?.();
        return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
          return { role: "assistant", content: "" };
        })();
      }
      if (call === 2) {
        return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
          return { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "Write", arguments: "{}" } }] };
        })();
      }
      return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
        return { role: "assistant", content: "写完了" };
      })();
    }) as any;
    await runTurn({
      session: s, config, registry: r, ctx, gate: stubGate,
      streamChat: streamChatMock,
      executeToolCalls: async (tcs: { id: string }[]) => tcs.map((tc) => ({ role: "tool", tool_call_id: tc.id, content: "ok" } as ToolMessage)),
      write: () => {},
    });
    expect(choiceSeen[0]).toBeUndefined(); // 首次请求:不强制
    expect(choiceSeen[1]).toBe("required"); // 预算耗尽后的重试:API 层硬约束
    expect(toolsSeen[0]).toContain("Skill"); // 首次请求:完整工具集
    expect(toolsSeen[1]).toEqual(["Write", "Bash"]); // 重试:元工具/纯读工具被剔除
    expect(choiceSeen[2]).toBeUndefined(); // 恢复正常后的下一轮:不再强制
    expect(toolsSeen[2]).toContain("Skill"); // 也恢复完整工具集
  });

  it("预算耗尽重试:第一档仍为空 → 加大输出预算到 32000 再强制一次,而不是直接放弃本轮", async () => {
    // 为什么是 32000 而不是继续加码:347 个 trial 的 cache 记录实测,撞满上限的请求中位
    // 生成速率约 60.7 tok/s——16000 tok≈264s(占 1800s 预算 14.7%),32000≈528s(29.3%),
    // 72000≈1187s(65.9%)。三档叠加(16k+32k+72k≈1979s)已经超过整个任务预算,最后一档
    // 必然在生成中途被 agent timeout 砍断、什么也留不下,所以阶梯到 32000 为止。
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    let call = 0;
    const maxTokensSeen: unknown[] = [];
    const choiceSeen: unknown[] = [];
    const streamChatMock = ((opts: StreamChatOptions) => {
      call++;
      maxTokensSeen.push(opts.maxTokens);
      choiceSeen.push((opts.extra as { tool_choice?: unknown } | undefined)?.tool_choice);
      if (call <= 2) {
        opts.onEmptyTruncation?.();
        return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
          return { role: "assistant", content: "" };
        })();
      }
      return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
        return { role: "assistant", content: "终于收敛了" };
      })();
    }) as any;
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: streamChatMock,
      executeToolCalls: async () => [],
      write: () => {},
    });
    expect(call).toBe(3); // 不再是"两次空就结束本轮"
    expect(maxTokensSeen[1]).toBeUndefined(); // 第一档:会话默认预算
    expect(maxTokensSeen[2]).toBe(32000); // 第二档:加大预算再强制一次
    expect(choiceSeen[2]).toBe("required");
  });

  it("服务端不接受 tool_choice → 回退一次普通重试,不让整轮崩掉", async () => {
    // 防御性:tool_choice 此前在 src/ 里零使用,各家 OpenAI 兼容网关支持程度未知。
    // 如果强制请求被拒,原先的行为是异常直接上抛、整个会话崩掉——比修复前更糟。
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    let call = 0;
    const choiceSeen: unknown[] = [];
    const streamChatMock = ((opts: StreamChatOptions) => {
      call++;
      choiceSeen.push((opts.extra as { tool_choice?: unknown } | undefined)?.tool_choice);
      if (call === 1) {
        opts.onEmptyTruncation?.();
        return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
          return { role: "assistant", content: "" };
        })();
      }
      if (call === 2) throw new Error("Invalid request: tool_choice is not supported by this endpoint");
      return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
        return { role: "assistant", content: "回退后的回答" };
      })();
    }) as any;
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: streamChatMock,
      executeToolCalls: async () => [],
      write: () => {},
    });
    expect(call).toBe(3);
    expect(choiceSeen[1]).toBe("required"); // 第一次尝试强制
    expect(choiceSeen[2]).toBeUndefined(); // 被拒后回退成普通重试
    expect(s.messages.at(-1)).toEqual({ role: "assistant", content: "回退后的回答" });
  });

  it("普通空响应(非 onEmptyTruncation)→ 重试不压低 reasoning_effort,只有思考耗尽预算这一支才压", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    let call = 0;
    const effortSeen: unknown[] = [];
    const streamChatMock = ((opts: StreamChatOptions) => {
      call++;
      effortSeen.push((opts.extra as { reasoning_effort?: unknown } | undefined)?.reasoning_effort);
      if (call === 1) {
        return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
          return { role: "assistant", content: "" }; // 空响应,但不是 onEmptyTruncation
        })();
      }
      return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
        yield { kind: "content", text: "补上的回答" };
        return { role: "assistant", content: "补上的回答" };
      })();
    }) as any;
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: streamChatMock,
      executeToolCalls: async () => [],
      write: () => {},
    });
    expect(call).toBe(2);
    expect(effortSeen[0]).toBe("max");
    expect(effortSeen[1]).toBe("max"); // 普通空响应重试:不是 reasoning 耗尽预算,不压低
  });

  it("tool_call 参数是半截/非法 JSON(如单次输出被截断)→ 落库版本清洗成合法 JSON,不污染历史", async () => {
    // 根因(真实撞见:20260717-143212-b8wt,glm-5.2 经火山方舟):模型单次 Write 写超大
    // 文件,JSON 参数生成到一半被截断,dispatch 本地解析失败(报"invalid JSON arguments"),
    // 但这条半截 JSON 的 assistant 消息此前会原样存进 session.messages——下一轮把它重发给
    // API 时,校验更严格的 provider(ARK)直接 400 Invalid request body,把整个会话卡死。
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    const badToolCall = { id: "c0", type: "function" as const, function: { name: "Write", arguments: '{"content": "开头没写完' } };
    const streamChatMock = scripted([
      turn([], { role: "assistant", content: null, tool_calls: [badToolCall] }),
      turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" }),
    ]);
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: streamChatMock,
      executeToolCalls: async () => [{ role: "tool", tool_call_id: "c0", content: "Error: invalid JSON arguments for Write" }],
      write: () => {},
    });
    const stored = s.messages.find(
      (m): m is AssistantMessage => m.role === "assistant" && !!m.tool_calls?.some((tc) => tc.id === "c0"),
    )!;
    expect(stored.tool_calls![0]!.function.arguments).toBe("{}"); // 落库版本清洗成合法 JSON
    expect(stored.tool_calls![0]!.function.name).toBe("Write"); // 只清洗 arguments,不动其它字段
  });

  it("主备模型都遇到网络/超时类异常 → 退避后整轮重试,不让整个episode崩溃退出", async () => {
    // 根因(真实撞见:terminal-bench make-mips-interpreter):模型试图单次Write写入
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

  it("限流(429):不换模型,原样等待重试(有 fallbackModel 也不降级)", async () => {
    process.env.DAO_RATE_LIMIT_WAIT_MS = "1"; // 测试里不等真实退避
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    let call = 0;
    const modelsUsed: string[] = [];
    const streamChatMock = ((opts: StreamChatOptions) => {
      call++;
      modelsUsed.push(opts.model);
      if (call === 1) {
        return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
          throw Object.assign(new Error("API error 429: token_plan_person_rate_limit_exceeded"), { status: 429 });
        })();
      }
      return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
        yield { kind: "content", text: "限流解除后成功" };
        return { role: "assistant", content: "限流解除后成功" };
      })();
    }) as any;
    // ctx 没有 askChoice(非交互场景)→ 自动等待重试,不问用户
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: streamChatMock,
      fallbackModel: "deepseek-v4-flash",
      executeToolCalls: async () => [],
      write: () => {},
    });
    delete process.env.DAO_RATE_LIMIT_WAIT_MS;
    expect(call).toBe(2);
    expect(modelsUsed).toEqual(["deepseek-v4-pro", "deepseek-v4-pro"]); // 全程主模型,没换成 flash
    expect(s.messages.at(-1)).toEqual({ role: "assistant", content: "限流解除后成功" });
  });

  it("限流(429):交互场景问用户,选\"中止\"则不重试、报明确错误(不降级)", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    let call = 0;
    let askedQuestion = "";
    let askedOptions: string[] = [];
    const streamChatMock = (() => {
      call++;
      return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
        throw Object.assign(new Error("API error 429: rate_limit_exceeded"), { status: 429 });
      })();
    }) as any;
    const interactiveCtx = {
      ...ctx,
      askChoice: async (q: string, opts: string[]) => {
        askedQuestion = q; askedOptions = opts;
        return opts[1]!; // 选"中止"
      },
    };
    await expect(
      runTurn({
        session: s, config, registry: emptyReg(), ctx: interactiveCtx as any, gate: stubGate,
        streamChat: streamChatMock,
        fallbackModel: "deepseek-v4-flash",
        executeToolCalls: async () => [],
        write: () => {},
      }),
    ).rejects.toThrow(/限流|429/);
    expect(call).toBe(1); // 没有换模型重试,只问了一次就中止
    expect(askedQuestion).toMatch(/限流/);
    expect(askedOptions.length).toBe(2);
  });

  it("限流(429):交互场景菜单列出其它账号,选中后切换并用新账号重试", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    let call = 0;
    const baseUrlsUsed: string[] = [];
    const switchedTo: string[] = [];
    const liveConfig = { baseUrl: "https://old", apiKey: "sk-old" };
    const streamChatMock = ((opts: StreamChatOptions) => {
      call++;
      baseUrlsUsed.push(opts.baseUrl);
      if (call === 1) {
        return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
          throw Object.assign(new Error("API error 429: rate_limit_exceeded"), { status: 429 });
        })();
      }
      return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
        yield { kind: "content", text: "切换后成功" };
        return { role: "assistant", content: "切换后成功" };
      })();
    }) as any;
    let askedOptions: string[] = [];
    const interactiveCtx = {
      ...ctx,
      askChoice: async (_q: string, opts: string[]) => {
        askedOptions = opts;
        return opts.find((o) => o.includes("work"))!; // 选"切到账号「work」重试"
      },
    };
    await runTurn({
      session: s, config: liveConfig, registry: emptyReg(), ctx: interactiveCtx as any, gate: stubGate,
      streamChat: streamChatMock,
      executeToolCalls: async () => [],
      write: () => {},
      listOtherAccounts: () => [{ name: "work" }, { name: "backup" }],
      switchAccountAndWait: async (name) => {
        switchedTo.push(name);
        liveConfig.baseUrl = "https://work"; // 模拟 index.ts 里对活引用 cfg 的原地修改
        liveConfig.apiKey = "sk-work";
        return true;
      },
    });
    expect(askedOptions).toEqual([
      "等待后用当前模型重试",
      "切到账号「work」重试",
      "切到账号「backup」重试",
      "中止本轮(稍后可用 /account 切换账号)",
    ]);
    expect(switchedTo).toEqual(["work"]);
    expect(call).toBe(2);
    expect(baseUrlsUsed).toEqual(["https://old", "https://work"]); // 第二次请求确实用了切换后的 baseUrl
    expect(s.messages.at(-1)).toEqual({ role: "assistant", content: "切换后成功" });
  });

  it("限流(429):切换账号失败时不静默吞掉,报错并中止", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    const noticed: string[] = [];
    const streamChatMock = (() =>
      (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
        throw Object.assign(new Error("API error 429: rate_limit_exceeded"), { status: 429 });
      })()) as any;
    const interactiveCtx = {
      ...ctx,
      askChoice: async (_q: string, opts: string[]) => opts.find((o) => o.includes("work"))!,
    };
    await expect(
      runTurn({
        session: s, config, registry: emptyReg(), ctx: interactiveCtx as any, gate: stubGate,
        streamChat: streamChatMock,
        executeToolCalls: async () => [],
        write: (t) => noticed.push(t),
        listOtherAccounts: () => [{ name: "work" }],
        switchAccountAndWait: async () => false, // 模拟凭据解析失败
      }),
    ).rejects.toThrow(/限流|429/);
    expect(noticed.some((t) => t.includes("切换到账号「work」失败"))).toBe(true);
  });

  it("限流(429):没有 listOtherAccounts 时菜单不出现账号选项(行为同现状)", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    let askedOptions: string[] = [];
    const streamChatMock = (() =>
      (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
        throw Object.assign(new Error("API error 429: rate_limit_exceeded"), { status: 429 });
      })()) as any;
    const interactiveCtx = {
      ...ctx,
      askChoice: async (_q: string, opts: string[]) => {
        askedOptions = opts;
        return opts.at(-1)!; // 中止
      },
    };
    await expect(
      runTurn({
        session: s, config, registry: emptyReg(), ctx: interactiveCtx as any, gate: stubGate,
        streamChat: streamChatMock,
        executeToolCalls: async () => [],
        write: () => {},
      }),
    ).rejects.toThrow(/限流|429/);
    expect(askedOptions).toEqual(["等待后用当前模型重试", "中止本轮(稍后可用 /account 切换账号)"]);
  });

  it("过载/超时类(非限流):交互场景问用户,选\"等待\"则原地重试(不自动换模型)", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    let call = 0;
    const modelsUsed: string[] = [];
    let askedQuestion = "";
    let askedOptions: string[] = [];
    process.env.DAO_RATE_LIMIT_WAIT_MS = "1";
    const streamChatMock = ((opts: StreamChatOptions) => {
      call++;
      modelsUsed.push(opts.model);
      if (call === 1) {
        return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
          throw new Error("模型流空闲超时(120s 未收到数据),已停止本回合");
        })();
      }
      return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
        yield { kind: "content", text: "等待后成功" };
        return { role: "assistant", content: "等待后成功" };
      })();
    }) as any;
    const interactiveCtx = {
      ...ctx,
      askChoice: async (q: string, opts: string[]) => {
        askedQuestion = q; askedOptions = opts;
        return opts[0]!; // 选"等待后用当前模型重试"
      },
    };
    await runTurn({
      session: s, config, registry: emptyReg(), ctx: interactiveCtx as any, gate: stubGate,
      streamChat: streamChatMock,
      fallbackModel: "deepseek-v4-flash",
      executeToolCalls: async () => [],
      write: () => {},
    });
    delete process.env.DAO_RATE_LIMIT_WAIT_MS;
    expect(call).toBe(2);
    expect(modelsUsed).toEqual(["deepseek-v4-pro", "deepseek-v4-pro"]); // 没自动换成 flash
    expect(askedQuestion).toMatch(/请求持续失败/);
    expect(askedOptions).toEqual(["等待后用当前模型重试", "换成备用模型「deepseek-v4-flash」试试(本回合)", "中止本轮"]);
    expect(s.messages.at(-1)).toEqual({ role: "assistant", content: "等待后成功" });
  });

  it("过载/超时类(非限流):交互场景选\"换成备用模型\"才切换(用户主动选,不是自动降级)", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    const modelsUsed: string[] = [];
    const streamChatMock = ((opts: StreamChatOptions) => {
      modelsUsed.push(opts.model);
      if (opts.model === "deepseek-v4-pro") {
        return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
          throw new Error("模型流空闲超时(120s 未收到数据),已停止本回合");
        })();
      }
      return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
        yield { kind: "content", text: "换模型后成功" };
        return { role: "assistant", content: "换模型后成功" };
      })();
    }) as any;
    const interactiveCtx = {
      ...ctx,
      askChoice: async (_q: string, opts: string[]) => opts[1]!, // 选"换成备用模型"
    };
    await runTurn({
      session: s, config, registry: emptyReg(), ctx: interactiveCtx as any, gate: stubGate,
      streamChat: streamChatMock,
      fallbackModel: "deepseek-v4-flash",
      executeToolCalls: async () => [],
      write: () => {},
    });
    expect(modelsUsed).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
    expect(s.messages.at(-1)).toEqual({ role: "assistant", content: "换模型后成功" });
  });

  it("过载/超时类(非限流):交互场景选\"中止\"则报明确错误,不重试", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    let call = 0;
    const streamChatMock = (() => {
      call++;
      return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
        throw new Error("模型流空闲超时(120s 未收到数据),已停止本回合");
      })();
    }) as any;
    const interactiveCtx = { ...ctx, askChoice: async (_q: string, opts: string[]) => opts.at(-1)! }; // 选"中止本轮"
    await expect(
      runTurn({
        session: s, config, registry: emptyReg(), ctx: interactiveCtx as any, gate: stubGate,
        streamChat: streamChatMock,
        fallbackModel: "deepseek-v4-flash",
        executeToolCalls: async () => [],
        write: () => {},
      }),
    ).rejects.toThrow(/已中止/);
    expect(call).toBe(1);
  });

  it("过载/超时类(非限流):没配置 fallbackModel 时,选项里不出现\"换成备用模型\"", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    let askedOptions: string[] = [];
    const streamChatMock = (() => (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
      throw new Error("模型流空闲超时(120s 未收到数据),已停止本回合");
    })()) as any;
    const interactiveCtx = {
      ...ctx,
      askChoice: async (_q: string, opts: string[]) => { askedOptions = opts; return opts.at(-1)!; },
    };
    await expect(
      runTurn({
        session: s, config, registry: emptyReg(), ctx: interactiveCtx as any, gate: stubGate,
        streamChat: streamChatMock,
        // 没有 fallbackModel
        executeToolCalls: async () => [],
        write: () => {},
      }),
    ).rejects.toThrow(/已中止/);
    expect(askedOptions).toEqual(["等待后用当前模型重试", "中止本轮"]);
  });

  it("headless(无 askChoice):过载/超时类仍走原自动回退+退避重试(不受这次改动影响)", async () => {
    process.env.DAO_HARD_RETRY_DELAY_MS = "1";
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    const modelsUsed: string[] = [];
    let call = 0;
    const streamChatMock = ((opts: StreamChatOptions) => {
      call++;
      modelsUsed.push(opts.model);
      if (call <= 2) {
        return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
          throw new Error("模型流空闲超时(120s 未收到数据),已停止本回合");
        })();
      }
      return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
        yield { kind: "content", text: "自动恢复成功" };
        return { role: "assistant", content: "自动恢复成功" };
      })();
    }) as any;
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate, // ctx 无 askChoice
      streamChat: streamChatMock,
      fallbackModel: "deepseek-v4-flash",
      executeToolCalls: async () => [],
      write: () => {},
    });
    delete process.env.DAO_HARD_RETRY_DELAY_MS;
    expect(call).toBe(3);
    expect(modelsUsed).toEqual(["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-pro"]); // 自动回退过
    expect(s.messages.at(-1)).toEqual({ role: "assistant", content: "自动恢复成功" });
  });

  it("sends session.model and runs tools then loops", async () => {
    const s = new Session("SYS", "deepseek-v4-flash");
    s.addUser("go");
    let sentModel = "";
    const assistantWithTool: AssistantMessage = {
      role: "assistant", content: null,
      tool_calls: [{ id: "c0", type: "function", function: { name: "Read", arguments: "{}" } }],
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

  it("gate 熔断跳闸(consumeTripNotice)时同步 events.notice,不能静默降级(复盘 20260721-215548-uq75)", async () => {
    // 根因:PermissionGate 熔断后 auto 模式静默退回全人工审批,30 分钟后又静默恢复——用户
    // 完全不知道 auto 已经名存实亡,只能靠"怎么老在问我"自己反推。gate 侧已经暴露了
    // consumeTripNotice() 一次性通知,这里验证 runTurn 真的在工具执行后消费并渲染给用户看。
    const s = new Session("SYS", "deepseek-v4-flash");
    s.addUser("go");
    const assistantWithTool: AssistantMessage = {
      role: "assistant", content: null,
      tool_calls: [{ id: "c0", type: "function", function: { name: "Read", arguments: "{}" } }],
    };
    const toolMsgs: ToolMessage[] = [{ role: "tool", tool_call_id: "c0", content: "R" }];
    let tripCalls = 0;
    const trippedGate: ApprovalGate = {
      decide: () => "allow",
      decideAsync: async () => "allow",
      requestBatch: async () => new Map(),
      consumeTripNotice: () => { tripCalls++; return { consecutiveDenials: 3, totalDenials: 3 }; },
    };
    const written: string[] = [];
    await runTurn({
      session: s, config, registry: emptyReg(), ctx,
      gate: trippedGate,
      streamChat: (() => turn([], assistantWithTool)()) as any,
      executeToolCalls: async () => toolMsgs,
      write: (t) => written.push(t),
      maxTurns: 1,
    });
    expect(tripCalls).toBeGreaterThan(0);
    expect(written.join("")).toContain("熔断");
  });

  it("gate 没有跳闸(consumeTripNotice 返回 null)时不产生任何熔断提示", async () => {
    const s = new Session("SYS", "deepseek-v4-flash");
    s.addUser("go");
    const assistantWithTool: AssistantMessage = {
      role: "assistant", content: null,
      tool_calls: [{ id: "c0", type: "function", function: { name: "Read", arguments: "{}" } }],
    };
    const toolMsgs: ToolMessage[] = [{ role: "tool", tool_call_id: "c0", content: "R" }];
    const calmGate: ApprovalGate = {
      decide: () => "allow",
      decideAsync: async () => "allow",
      requestBatch: async () => new Map(),
      consumeTripNotice: () => null,
    };
    const written: string[] = [];
    await runTurn({
      session: s, config, registry: emptyReg(), ctx,
      gate: calmGate,
      streamChat: (() => turn([], assistantWithTool)()) as any,
      executeToolCalls: async () => toolMsgs,
      write: (t) => written.push(t),
      maxTurns: 1,
    });
    expect(written.join("")).not.toContain("熔断");
  });

  it("onCheckpoint:每个工具轮结束都调用一次(不等整个回合跑完才存档)", async () => {
    const s = new Session("SYS", "deepseek-v4-flash");
    s.addUser("go");
    const assistantWithTool: AssistantMessage = {
      role: "assistant", content: null,
      tool_calls: [{ id: "c0", type: "function", function: { name: "Read", arguments: "{}" } }],
    };
    const calls = scripted([
      turn([], assistantWithTool), // 第1轮:调工具
      turn([], assistantWithTool), // 第2轮:再调一次工具
      turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" }), // 第3轮:收尾
    ]);
    let checkpoints = 0;
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: (() => calls()) as any,
      executeToolCalls: async () => [{ role: "tool", tool_call_id: "c0", content: "R" }],
      write: () => {},
      onCheckpoint: () => { checkpoints++; },
    });
    // 两次工具轮都落盘;最后纯文本收尾那轮走的是"直接 return"早退路径(没有新工具结果要保护),
    // 不额外触发——回合末外层的 persist() 已经会存一次完整最终状态,不依赖这里补。
    expect(checkpoints).toBe(2);
  });

  it("§4 轮内主动压缩:shouldCompact=true 时在工具轮之间调 compact(不等回合末)", async () => {
    const s = new Session("SYS", "m");
    s.addUser("go");
    const assistantWithTool: AssistantMessage = {
      role: "assistant", content: null,
      tool_calls: [{ id: "c0", type: "function", function: { name: "Read", arguments: "{}" } }],
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
      turn([], { role: "assistant", content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "Read", arguments: "{}" } }] }),
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
    const readTurn = () => turn([], { role: "assistant", content: null, tool_calls: [{ id: "r", type: "function", function: { name: "Read", arguments: "{}" } }] })();
    const turns = [readTurn, readTurn, readTurn, readTurn, readTurn, () => turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" })()];
    let i = 0;
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: (() => turns[i++]!()) as any,
      executeToolCalls: async () => [{ role: "tool", tool_call_id: "r", content: "R" }],
      write: () => {},
      maxTurns: 10,
      progressAdvice: true,
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
    const readTurn = () => turn([], { role: "assistant", content: null, tool_calls: [{ id: "r", type: "function", function: { name: "Read", arguments: "{}" } }] })();
    const turns = [readTurn, readTurn, readTurn, readTurn, readTurn, () => turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" })()];
    let i = 0;
    const written: string[] = [];
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: (() => turns[i++]!()) as any,
      executeToolCalls: async () => [{ role: "tool", tool_call_id: "r", content: "R" }],
      write: (t) => written.push(t),
      maxTurns: 10,
      progressAdvice: true,
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
    const readTurn = () => turn([], { role: "assistant", content: null, tool_calls: [{ id: "r", type: "function", function: { name: "Read", arguments: "{}" } }] })();
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
      progressAdvice: true,
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
    const readTurn = () => turn([], { role: "assistant", content: null, tool_calls: [{ id: "r", type: "function", function: { name: "Read", arguments: "{}" } }] })();
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
      progressAdvice: true,
    });
    const sys = s.messages.filter((m) => m.role === "system").map((m) => String(m.content));
    expect(sys.some((c) => c.includes("[进度提醒]") && !c.includes("第2次"))).toBe(true); // 第1次
    expect(sys.some((c) => c.includes("[进度提醒·第2次]") && c.includes("前面提醒过") && c.includes("写脚本算出来"))).toBe(true); // 第2次:强调已提醒过
    expect(written.join("")).toContain("进度提醒·第2次");
  });

  it("卡住期间中途真的推进过一次 → 计数清零,后续再卡住重新从通用措辞开始", async () => {
    const s = new Session("SYS", "m");
    s.addUser("go");
    const readTurn = () => turn([], { role: "assistant", content: null, tool_calls: [{ id: "r", type: "function", function: { name: "Read", arguments: "{}" } }] })();
    const writeTurn = () => turn([], { role: "assistant", content: null, tool_calls: [{ id: "w", type: "function", function: { name: "Write", arguments: "{}" } }] })();
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
      progressAdvice: true,
    });
    const sys = s.messages.filter((m) => m.role === "system").map((m) => String(m.content));
    // 两次触发都应该是"第1次"(通用措辞),因为中途的 Write 把 stuckAdviceCount 清零了。
    expect(sys.filter((c) => c.includes("[进度提醒]") && !c.includes("第")).length).toBe(2);
    expect(sys.some((c) => c.includes("第2次"))).toBe(false);
  });

  it("同一会话反复卡住又被零星编辑清零 → 第3次即使是'新的一次卡住'也要升级措辞,不能无限靠清零规避", async () => {
    // 根因(内省复盘 make-mips-interpreter 时发现):模型卡在同一个printf/内存字节问题上
    // 反复假设了两个多小时,期间进度提醒确实触发过3次,但每次都被穿插的零星Edit清零了
    // stuckAdviceCount,导致每次都只拿到"第1次"的通用措辞,从未真正升级——跟raman-fitting
    // 那次发现的检测盲区同一个根因。totalStuckEvents不受清零影响,累计到3次就该升级,
    // 不管当前这次"卡住"是不是刚重新开始计数的。
    const s = new Session("SYS", "m");
    s.addUser("go");
    const readTurn = () => turn([], { role: "assistant", content: null, tool_calls: [{ id: "r", type: "function", function: { name: "Read", arguments: "{}" } }] })();
    const writeTurn = () => turn([], { role: "assistant", content: null, tool_calls: [{ id: "w", type: "function", function: { name: "Write", arguments: "{}" } }] })();
    // 3轮"5轮空转+1轮零星编辑清零"循环,第3次卡住触发时 totalStuckEvents 应达到3、需要升级。
    const cycle = [...Array.from({ length: 5 }, () => readTurn), writeTurn];
    const turns = [
      ...cycle, ...cycle, ...cycle,
      () => turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" })(),
    ];
    let i = 0;
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: (() => turns[i++]!()) as any,
      executeToolCalls: async (calls) => calls.map((c) => ({ role: "tool" as const, tool_call_id: c.id, content: "R" })),
      write: () => {},
      maxTurns: 25,
      progressAdvice: true,
    });
    const sys = s.messages.filter((m) => m.role === "system").map((m) => String(m.content));
    // 第1、2次仍是通用措辞(totalStuckEvents=1,2,不够3);第3次即使stuckAdviceCount又是1,
    // 也应该因totalStuckEvents=3而升级,带具体的"写脚本/加调试打印"动作指令。
    expect(sys.filter((c) => c.includes("[进度提醒]") && !c.includes("第")).length).toBe(2);
    expect(sys.some((c) => c.includes("本会话第3次卡住") && c.includes("最小验证脚本或加一行调试打印"))).toBe(true);
  });

  it("默认不传 progressAdvice → 进度提醒机制不触发,即使连续多轮无推进(默认关闭)", async () => {
    const s = new Session("SYS", "m");
    s.addUser("go");
    const readTurn = () => turn([], { role: "assistant", content: null, tool_calls: [{ id: "r", type: "function", function: { name: "Read", arguments: "{}" } }] })();
    const turns = [
      ...Array.from({ length: 10 }, () => readTurn), // 远超 ADVISE_EVERY(默认5)的两倍
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
      // 不传 progressAdvice
    });
    expect(s.messages.some((m) => m.role === "system" && String(m.content).includes("进度提醒"))).toBe(false);
    expect(written.join("")).not.toContain("进度提醒");
  });

  it("轮数提醒(接近 maxTurns)触发时同步 events.notice", async () => {
    // 同一处代码块里的另一条 advisory,同一个盲区——一并补上可见提示。
    const s = new Session("SYS", "m");
    s.addUser("go");
    // maxTurns=6 → t===1 时命中 t===maxTurns-5,用推进型工具调用避免同时触发进度提醒混淆断言。
    const writeTurn = () => turn([], { role: "assistant", content: null, tool_calls: [{ id: "w", type: "function", function: { name: "Write", arguments: "{}" } }] })();
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

  it("drainEnvNotices:回合边界把环境探测补充注入为 system 消息(不发可见提示)", async () => {
    const s = new Session("SYS", "m");
    s.addUser("go");
    let drained = false;
    const out: string[] = [];
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" }) as any,
      executeToolCalls: async () => [],
      write: (sx) => out.push(sx),
      drainEnvNotices: () => (drained ? [] : (drained = true, ["<环境探测补充>...</环境探测补充>"])),
    });
    expect(s.messages.some((m) => m.role === "system" && String(m.content).includes("<环境探测补充>"))).toBe(true);
  });

  it("drainEnvNotices:只投递一次,不重复注入", async () => {
    const s = new Session("SYS", "m");
    s.addUser("go");
    let calls = 0;
    await runTurn({
      session: s, config, registry: emptyReg(), ctx, gate: stubGate,
      streamChat: scripted([
        turn([], { role: "assistant", content: null, tool_calls: [{ id: "w", type: "function", function: { name: "Write", arguments: "{}" } }] }),
        turn([{ kind: "content", text: "done" }], { role: "assistant", content: "done" }),
      ]),
      executeToolCalls: async () => [{ role: "tool", tool_call_id: "w", content: "ok" }],
      write: () => {},
      drainEnvNotices: () => { calls++; return calls === 1 ? ["<环境探测补充>...</环境探测补充>"] : []; },
    });
    const count = s.messages.filter((m) => m.role === "system" && String(m.content).includes("<环境探测补充>")).length;
    expect(count).toBe(1);
  });

  it("omits write/exec tools in plan mode", async () => {
    const r = new ToolRegistry();
    r.register(defineTool({ name: "Read", description: "", capability: "read", approval: "auto", schema: z.object({}), handler: async () => "" }));
    r.register(defineTool({ name: "Write", description: "", capability: "write", approval: "required", schema: z.object({}), handler: async () => "" }));
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
    expect(sentTools).toEqual(["Read"]);
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
      tool_calls: [{ id: "c0", type: "function", function: { name: "Read", arguments: "{}" } }],
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

  it("aborted mid-reasoning with no content/tool_calls yet: stops immediately, no phantom empty-response retry", async () => {
    const s = new Session("SYS", "m");
    s.addUser("go");
    const controller = new AbortController();
    let calls = 0;
    const notices: string[] = [];
    await runTurn({
      session: s,
      config,
      registry: emptyReg(),
      ctx,
      gate: stubGate,
      // 模拟 client.ts 的真实 abort 行为:ESC 落在还没产出任何 content/tool_calls 时,
      // 生成器不抛错,优雅返回一个空 assistant 消息(见 client.ts isAbort 分支)。
      streamChat: (() => {
        calls++;
        controller.abort();
        return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
          return { role: "assistant", content: null };
        })();
      }) as any,
      executeToolCalls: async () => [],
      write: (t) => notices.push(t),
      signal: controller.signal,
    });
    expect(calls).toBe(1); // 不应该在已 abort 后又发第二次请求
    expect(notices.join("")).not.toContain("空响应");
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
    r.register(defineTool({ name: "Read", description: "", capability: "read", approval: "auto", schema: z.object({}), handler: async () => "" }));
    r.register(defineTool({ name: "Write", description: "", capability: "write", approval: "required", schema: z.object({}), handler: async () => "" }));
    const s = new Session("SYS", "m");
    s.addUser("create a file");
    s.toggleMode(); // → plan
    let executedCalls = 0;
    const calls = scripted([
      turn([], { role: "assistant", content: null, tool_calls: [{ id: "w0", type: "function", function: { name: "Write", arguments: "{}" } }] }),
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
    expect(executedCalls).toBe(0); // Write never dispatched in plan
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
      tool_calls: [{ id, type: "function", function: { name: "Bash", arguments: "{}" } }],
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
      turn([], { role: "assistant", content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "Read", arguments: "{}" } }] }),
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

});

describe("sanitizeHistoryForResume", () => {
  it("清洗续写时从磁盘加载的历史里,半截/非法 JSON 的 tool_call", () => {
    // 根因(真实撞见:20260717-143212-b8wt):一个跑着旧代码(无清洗逻辑)、迟迟没重启的
    // 进程把这类坏消息存进了 state.json;之后用修复后的新版 dao 续写,原样加载回来又会
    // 撞上同一个 400 Invalid request body——sanitizeForHistory 只清洗"本进程新生成"的
    // 消息,不覆盖"续写时加载进来的旧历史",所以续写路径需要单独再过一遍。
    const badToolCall = { id: "c0", type: "function" as const, function: { name: "Write", arguments: '{"content": "半截没写完' } };
    const messages = [
      { role: "system" as const, content: "SYS" },
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: null, tool_calls: [badToolCall] },
      { role: "tool" as const, tool_call_id: "c0", content: "Error: invalid JSON arguments for Write" },
    ];
    const cleaned = sanitizeHistoryForResume(messages);
    const assistant = cleaned.find((m) => m.role === "assistant") as AssistantMessage;
    expect(assistant.tool_calls![0]!.function.arguments).toBe("{}");
    // 其它角色的消息原样保留,不受影响
    expect(cleaned.filter((m) => m.role !== "assistant")).toEqual(messages.filter((m) => m.role !== "assistant"));
  });

  it("合法 JSON 的历史原样返回,不做无谓改写", () => {
    const goodToolCall = { id: "c0", type: "function" as const, function: { name: "Read", arguments: '{"path": "a.ts"}' } };
    const messages = [
      { role: "assistant" as const, content: null, tool_calls: [goodToolCall] },
    ];
    expect(sanitizeHistoryForResume(messages)).toEqual(messages);
  });
});
