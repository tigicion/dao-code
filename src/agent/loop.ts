import type {
  AssistantMessage,
  StreamChatOptions,
  StreamDelta,
  ToolCall,
  ToolMessage,
} from "../client/types.js";
import type { ToolContext } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ApprovalGate } from "../approval/types.js";
import type { Session } from "../session/session.js";
import { apiToolsForMode } from "../tools/tools_for_mode.js";
import { consumeStream, plainEvents, type TurnEvents } from "../tui/render.js";

export interface TurnDeps {
  session: Session;
  config: { baseUrl: string; apiKey: string };
  registry: ToolRegistry;
  ctx: ToolContext;
  gate: ApprovalGate;
  streamChat: (opts: StreamChatOptions) => AsyncGenerator<StreamDelta, AssistantMessage>;
  executeToolCalls: (
    toolCalls: ToolCall[],
    registry: ToolRegistry,
    ctx: ToolContext,
    gate: ApprovalGate,
  ) => Promise<ToolMessage[]>;
  write: (s: string) => void;
  // 渲染事件汇:省略则用 plainEvents(write) 复刻终端 ANSI 输出(eval/子代理/非 TTY)。
  // Ink 路径传入自己的适配器,把流式喂进 React state。
  events?: TurnEvents;
  maxTurns?: number;
  // 本回合临时注入的系统提示(如"相关技能"发现),只随本回合发给模型、不写入 session.messages(不累积、不持久)。
  transientSystem?: string;
  // B 条件路径技能:每批工具执行后调用,据被操作文件激活匹配的条件技能;返回要注入的正文(一次性写入 session)。
  activateSkillsForPaths?: (calls: ToolCall[]) => string | undefined;
  // A 写操作 pivot:模型转向写/改文件后调用,据其意图重算"相关技能发现"提示;返回新 transient(空串=清除),undefined=不变。
  rediscoverAfterWrite?: (calls: ToolCall[], assistantContent: string) => string | undefined;
  // 中途取消信号(ESC/超时):透传给 streamChat 与工具 ctx;abort 后本回合优雅停止。
  signal?: AbortSignal;
  // 回合边界消费的追加消息(SendMessage 给运行中子代理用):每个工具回合前注入为 user 消息。
  drainPending?: () => string[];
}

// 在已有的 session.messages 上跑一个用户回合,直到模型不再请求工具。
export async function runTurn(deps: TurnDeps): Promise<void> {
  const { session, signal } = deps;
  const events = deps.events ?? plainEvents(deps.write);
  // 工具 ctx 透传取消信号(exec_shell 据此 SIGTERM);不改原 ctx 引用,按需补 signal。
  const toolCtx = signal ? { ...deps.ctx, signal } : deps.ctx;
  // 边界保护对标 CC:纯量化——主会话不限轮数(undefined→Infinity,靠 token 预算触发 compact),
  // 子代理传 200。DAO_MAX_TURNS 仍作硬上限覆盖(eval/自动化用)。无质化卡死检测。
  const maxTurns = deps.maxTurns ?? (Number(process.env.DAO_MAX_TURNS) || Infinity);
  let transient = deps.transientSystem; // 可变:写操作 pivot 后会被刷新(见 afterTools)
  // 每批工具执行后:① 条件路径技能自动激活(注入正文一次);② 写 pivot 刷新软发现提示。
  const afterTools = (calls: ToolCall[], assistant: AssistantMessage): void => {
    if (deps.activateSkillsForPaths) {
      const inject = deps.activateSkillsForPaths(calls);
      if (inject) {
        session.messages.push({ role: "system", content: inject });
        events.notice("\n[条件技能已自动激活]\n");
      }
    }
    if (deps.rediscoverAfterWrite) {
      const r = deps.rediscoverAfterWrite(calls, typeof assistant.content === "string" ? assistant.content : "");
      if (r !== undefined) transient = r || undefined;
    }
  };
  for (let t = 0; t < maxTurns; t++) {
    if (signal?.aborted) return; // 上一轮工具执行后被取消,直接收尾
    // SendMessage:回合边界消费父代理追加的指令(注入为 user 消息)。
    if (deps.drainPending) {
      for (const m of deps.drainPending()) session.messages.push({ role: "user", content: `[追加指令] ${m}` });
    }
    const tools = apiToolsForMode(deps.registry, session.mode);
    // 临时系统提示(相关技能发现)附在消息尾部,只这一回合发出、不写回 session.messages(不累积/缓存友好)。
    const sentMessages = transient
      ? [...session.messages, { role: "system" as const, content: transient }]
      : session.messages;
    const gen = deps.streamChat({
      baseUrl: deps.config.baseUrl,
      apiKey: deps.config.apiKey,
      model: session.model,
      messages: sentMessages,
      ...(tools.length > 0 ? { tools, parallelToolCalls: true } : {}),
      // agent 类客户端默认用最高思考强度(官方对 Claude Code/OpenCode 类亦自动升到 max)。
      // 可用 DAO_REASONING_EFFORT 覆盖(实验:max 可能放大"过度推敲、到了正解不下手")。
      // 思考模式下 temperature/top_p 无效,故不设采样参数。
      extra: { reasoning_effort: process.env.DAO_REASONING_EFFORT || "max" },
      onUsage: (u) => session.addUsage(u),
      signal,
    });
    const assistant = await consumeStream(gen, events);
    const toolCalls = assistant.tool_calls ?? [];
    const hasContent = typeof assistant.content === "string" && assistant.content.trim().length > 0;
    // 防御:空内容且无工具调用的回合(只有 reasoning、或被打断)不能入库——否则下一轮
    // DeepSeek 会 400「content or tool_calls must be set」直接崩会话。空回合直接结束。
    if (toolCalls.length === 0 && !hasContent) return;
    session.messages.push(assistant);
    if (signal?.aborted) return; // 流被 abort:部分消息已入库,不再执行工具,优雅停止。
    if (toolCalls.length === 0) return;

    if (session.mode === "plan") {
      // plan 模式的结构性强制:系统 prompt 仍列出全部工具,模型可能调用写/执行工具,
      // 但它们不在本轮允许表里——直接拒绝执行(不派发、不弹审批),回一条"不可用"消息。
      const allowed = new Set(tools.map((t) => t.function.name));
      const runnable = toolCalls.filter((tc) => allowed.has(tc.function.name));
      for (const tc of toolCalls) {
        if (!allowed.has(tc.function.name)) events.notice(`\n[plan 模式:拒绝 ${tc.function.name}]\n`);
      }
      const ran = runnable.length
        ? await deps.executeToolCalls(runnable, deps.registry, toolCtx, deps.gate)
        : [];
      const byId = new Map(ran.map((m) => [m.tool_call_id, m]));
      const toolMessages = toolCalls.map((tc) =>
        byId.get(tc.id) ?? {
          role: "tool" as const,
          tool_call_id: tc.id,
          content: `工具 ${tc.function.name} 在 plan 模式下不可用(只读+提方案)。如需修改请让用户切回 normal 模式。`,
        },
      );
      for (const tc of toolCalls) {
        const m = toolMessages.find((tm) => tm.tool_call_id === tc.id);
        if (m) events.toolResult(tc, m);
      }
      session.messages.push(...toolMessages);
      afterTools(toolCalls, assistant);
    } else {
      const toolMessages = await deps.executeToolCalls(toolCalls, deps.registry, toolCtx, deps.gate);
      for (const tc of toolCalls) {
        const m = toolMessages.find((tm) => tm.tool_call_id === tc.id);
        if (m) events.toolResult(tc, m);
      }
      session.messages.push(...toolMessages);
      afterTools(toolCalls, assistant);
    }
  }
  events.notice("\n[已达最大轮数,停止]\n");
}
