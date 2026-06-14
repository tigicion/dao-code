import type {
  AssistantMessage,
  ChatMessage,
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
import { isContextLengthError } from "../client/client.js";

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
  // L2.2 反应式压缩:streamChat 报"上下文超限"时调用它压缩后重试本轮(估算阈值之外的安全网)。
  compact?: () => Promise<void>;
  // L1.3 模型回退:主模型持续过载/异常时,本回合临时改用此模型跑完(如 flash)。省略=不回退。
  fallbackModel?: string;
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
  // L4.2/L4.3 进度追踪 + advisor 提醒:长任务空转/临近上限时注入一次性软提醒(不持久、缓存友好)。
  const ADVISE_EVERY = Number(process.env.DAO_ADVISE_EVERY) || 5;
  const PROGRESS_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "notebook_edit", "todo_write"]);
  let noProgress = 0;
  let advisory: string | undefined;

  // 一次"请求模型"的韧性封装:封装流式 + 反应式压缩重试 + 模型回退,失败才上抛(error withholding)。
  const reasoningEffort = process.env.DAO_REASONING_EFFORT || "max";
  const requestAssistant = async (tools: ReturnType<typeof apiToolsForMode>): Promise<AssistantMessage> => {
    let ctxRetries = 0; // 本轮反应式压缩次数上限,防压不动时死循环
    let usedFallback = false;
    for (;;) {
      // 临时系统提示(相关技能发现 + advisor 提醒)附在消息尾部:只这一回合发出、不写回 session.messages(不累积/缓存友好)。
      const extras: ChatMessage[] = [];
      if (transient) extras.push({ role: "system", content: transient });
      if (advisory) extras.push({ role: "system", content: advisory });
      const sent = extras.length ? [...session.messages, ...extras] : session.messages;
      const model = usedFallback && deps.fallbackModel ? deps.fallbackModel : session.model;
      try {
        const gen = deps.streamChat({
          baseUrl: deps.config.baseUrl,
          apiKey: deps.config.apiKey,
          model,
          messages: sent,
          ...(tools.length > 0 ? { tools, parallelToolCalls: true } : {}),
          // agent 类客户端默认最高思考强度;DAO_REASONING_EFFORT 可覆盖。思考模式下 temperature/top_p 无效。
          extra: { reasoning_effort: reasoningEffort },
          onUsage: (u) => session.addUsage(u),
          signal,
        });
        return await consumeStream(gen, events);
      } catch (e) {
        if (signal?.aborted) throw e; // 用户取消:不重试
        // L2.2 反应式压缩:上下文超限 → 压缩后重试本轮(最多 2 次)。
        if (isContextLengthError(e) && deps.compact && ctxRetries < 2) {
          ctxRetries++;
          events.notice("\n[上下文超限,自动压缩后重试…]\n");
          await deps.compact();
          continue;
        }
        // L1.3 模型回退:过载/5xx/网络类异常 → 本回合临时换 fallback 模型再试一次。
        if (deps.fallbackModel && !usedFallback && /5\d\d|overload|529|timeout|超时|连接.*失败|网络|非流式/i.test(e instanceof Error ? e.message : String(e))) {
          usedFallback = true;
          events.notice(`\n[主模型异常,本回合临时回退 ${deps.fallbackModel}…]\n`);
          continue;
        }
        throw e; // 恢复手段用尽:上抛(致命或网络彻底不通)
      }
    }
  };

  for (let t = 0; t < maxTurns; t++) {
    if (signal?.aborted) return; // 上一轮工具执行后被取消,直接收尾
    // SendMessage:回合边界消费父代理追加的指令(注入为 user 消息)。
    if (deps.drainPending) {
      for (const m of deps.drainPending()) session.messages.push({ role: "user", content: `[追加指令] ${m}` });
    }
    const tools = apiToolsForMode(deps.registry, session.mode);
    const assistant = await requestAssistant(tools);
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

    // L4.2/L4.3 进度评估:本轮有无"实质推进"(写文件/改文件/推进任务清单)。
    // 连续空转或临近上限 → 下一轮注入一次性 advisor 提醒,促其回看目标/收尾/求助,防长程漂移与空耗。
    const progressed = toolCalls.some((tc) => PROGRESS_TOOLS.has(tc.function.name));
    noProgress = progressed ? 0 : noProgress + 1;
    advisory = undefined;
    if (noProgress > 0 && noProgress % ADVISE_EVERY === 0) {
      advisory = `[进度提醒] 已连续 ${noProgress} 轮没有改动文件或推进任务清单。回看 todo 确认方向;若已完成请调用 verify_done 收尾;若卡住请换思路或用 ask_user 向用户求助,不要空转。`;
    }
    if (Number.isFinite(maxTurns) && t >= maxTurns - 5) {
      advisory = `${advisory ? advisory + " " : ""}[轮数提醒] 接近最大轮数(${t + 1}/${maxTurns}),请尽快收敛并收尾(必要时 verify_done 验收或向用户汇报现状)。`;
    }
  }
  events.notice("\n[已达最大轮数,停止]\n");
}
