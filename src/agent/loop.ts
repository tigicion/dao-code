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
import type { CacheAuditSink, CacheAuditInput } from "../session/cache_audit.js";
import type { Session } from "../session/session.js";
import { apiToolsForMode } from "../tools/tools_for_mode.js";
import { consumeStream, plainEvents, type TurnEvents } from "../tui/render.js";
import { isContextLengthError } from "../client/client.js";
import { looksFailed } from "../tools/execute.js";
import { assessTurn, initHealth, errSignature, defaultHealthConfig } from "./turn_health.js";

// 廉价稳定哈希(djb2):只用于"是否变化"的缓存归因指纹,不求抗碰撞。
function cheapHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

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
  // 中途取消信号(ESC/超时):透传给 streamChat 与工具 ctx;abort 后本回合优雅停止。
  signal?: AbortSignal;
  // 回合边界消费的追加消息(SendMessage 给运行中子代理用):每个工具回合前注入为 user 消息。
  drainPending?: () => string[];
  // L2.2 反应式压缩:streamChat 报"上下文超限"时调用它压缩后重试本轮(估算阈值之外的安全网)。
  compact?: () => Promise<void>;
  // L1.3 模型回退:主模型持续过载/异常时,本回合临时改用此模型跑完(如 flash)。省略=不回退。
  fallbackModel?: string;
  // P2-11 编辑后诊断:本轮有写/改文件时调用,返回非空则作为 [诊断] 系统消息回灌给模型自查自改。
  diagnose?: () => Promise<string | undefined>;
  // 背景运行(子代理/后台任务):遇 529 过载不在客户端重试、loop 也不回退,防并行子代理级联放大。
  background?: boolean;
  // 缓存审计:每次 API 调用把命中/指纹/变更落进根会话 cache.jsonl。省略=不审计。
  auditSink?: CacheAuditSink;
  // 本 runTurn 在 agent 树中的身份(main/子/fork/后台);depth 用于 agentKey 分桶。
  auditId?: { agent: CacheAuditInput["agent"]; subId?: string; depth: number };
  // 反思层:卡住(连续失败/同错复发)→ 挑战者;长任务周期 → 纠偏者。返回精简结论,作为 advisory 注入参考。
  // 省略则不反思(子代理/eval 不传)。impl 在 index.ts(fork 调用,复用热缓存)。
  reflect?: (kind: "challenger" | "refocuser") => Promise<string | null>;
  longTask?: boolean; // 长任务模式(纠偏者仅在此模式按周期触发)
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
  // L4.2/L4.3 进度追踪 + advisor 提醒:长任务空转/临近上限时,把提醒【追加】进 session.messages(append-only)。
  const ADVISE_EVERY = Number(process.env.DAO_ADVISE_EVERY) || 5;
  const PROGRESS_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "notebook_edit", "todo_write"]);
  let noProgress = 0;
  // 反思层:确定性回合监控状态(跨本 runTurn 的各模型回合累积)。
  let health = initHealth();
  const healthCfg = defaultHealthConfig();

  // 一次"请求模型"的韧性封装:封装流式 + 反应式压缩重试 + 模型回退,失败才上抛(error withholding)。
  const reasoningEffort = process.env.DAO_REASONING_EFFORT || "max";
  const requestAssistant = async (tools: ReturnType<typeof apiToolsForMode>, turn: number): Promise<AssistantMessage> => {
    let ctxRetries = 0; // 本轮反应式压缩次数上限,防压不动时死循环
    let usedFallback = false;
    for (;;) {
      // 【缓存纪律】绝不在请求尾部追加每轮变化的内容(发现提示/进度提醒等)。原因:这些是 role:"system"
      // 消息,被当作前置指令块——尾部一变就把其后【整段对话】的前缀缓存全废掉(实测命中率从 95% 塌到 ~14%)。
      // 提醒/激活类内容一律【append 进 session.messages】(append-only 增长,缓存安全),而不是这里临时拼。
      const sent = session.messages;
      if (deps.auditId?.agent === "main") session.lastSentLength = sent.length; // 记已缓存前缀边界,供蒸馏对齐(只主会话)
      const model = usedFallback && deps.fallbackModel ? deps.fallbackModel : session.model;
      // P1-47 缓存归因 + 缓存审计:先算原始内容,notePrefix 与审计共用。tail 恒为空(已无尾部临时注入)。
      const sysRaw = typeof session.messages[0]?.content === "string" ? (session.messages[0]!.content as string) : "";
      const toolsRaw = JSON.stringify(tools);
      const tailRaw = "";
      session.notePrefix({
        model,
        sys: cheapHash(sysRaw),
        tools: cheapHash(toolsRaw),
        tail: cheapHash(tailRaw),
      });
      try {
        const gen = deps.streamChat({
          baseUrl: deps.config.baseUrl,
          apiKey: deps.config.apiKey,
          model,
          messages: sent,
          ...(tools.length > 0 ? { tools, parallelToolCalls: true } : {}),
          // agent 类客户端默认最高思考强度;DAO_REASONING_EFFORT 可覆盖。思考模式下 temperature/top_p 无效。
          extra: { reasoning_effort: reasoningEffort },
          onUsage: (u) => {
            session.addUsage(u, model); // B-2 按模型记账
            deps.auditSink?.record({
              agent: deps.auditId?.agent ?? "main",
              ...(deps.auditId?.subId ? { subId: deps.auditId.subId } : {}),
              depth: deps.auditId?.depth ?? 0,
              turn, model, usage: u, sys: sysRaw, tools: toolsRaw, tail: tailRaw,
            });
          },
          signal,
          background: deps.background, // 背景查询 529 不重试
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
        // 背景查询(子代理)不回退,直接上抛 → 防并行子代理在过载时各自再打一发 flash 放大级联。
        if (!deps.background && deps.fallbackModel && !usedFallback && /5\d\d|overload|529|timeout|超时|连接.*失败|网络|非流式/i.test(e instanceof Error ? e.message : String(e))) {
          usedFallback = true;
          events.notice(`\n[主模型异常,本回合临时回退 ${deps.fallbackModel}…]\n`);
          continue;
        }
        throw e; // 恢复手段用尽:上抛(致命或网络彻底不通)
      }
    }
  };

  let budgetWarned = false;
  for (let t = 0; t < maxTurns; t++) {
    if (signal?.aborted) return; // 上一轮工具执行后被取消,直接收尾
    // P3-17 预算【可选提醒】:设了 budgetCNY 且累计成本超过它 → 提醒一次(不停);
    // 仅当显式 DAO_MAX_BUDGET_HARD=1 才硬停。默认不拦,把决定权留给用户。
    if (session.overBudget()) {
      if (!budgetWarned) { budgetWarned = true; events.notice(`\n[成本提醒] 本会话累计约 ¥${session.costCNY().toFixed(2)},已超阈值 ¥${session.budgetCNY}。\n`); }
      if (process.env.DAO_MAX_BUDGET_HARD === "1") { events.notice(`[已达硬预算上限,停止]\n`); return; }
    }
    // SendMessage:回合边界消费父代理追加的指令(注入为 user 消息)。
    if (deps.drainPending) {
      for (const m of deps.drainPending()) session.messages.push({ role: "user", content: `[追加指令] ${m}` });
    }
    const tools = apiToolsForMode(deps.registry, session.mode);
    const assistant = await requestAssistant(tools, t);
    const toolCalls = assistant.tool_calls ?? [];
    const hasContent = typeof assistant.content === "string" && assistant.content.trim().length > 0;
    // 防御:空内容且无工具调用的回合(只有 reasoning、或被打断)不能入库——否则下一轮
    // DeepSeek 会 400「content or tool_calls must be set」直接崩会话。空回合直接结束。
    if (toolCalls.length === 0 && !hasContent) return;
    session.messages.push(assistant);
    if (toolCalls.length === 0) return; // 纯文本回合(含被打断只剩 content):直接结束
    // 取消发生在记录 assistant(tool_calls) 之后、执行之前(模型已答完、用户随即 ESC):
    // 必须为每个 tool_call 补一条 tool 结果,否则下一轮历史里 assistant(tool_calls) 悬空,
    // DeepSeek 会 400「assistant message with 'tool_calls' must be followed by tool messages」直接崩会话。
    if (signal?.aborted) {
      session.messages.push(
        ...toolCalls.map((tc): ToolMessage => ({ role: "tool", tool_call_id: tc.id, content: "[已取消] 用户中断本回合,未执行该工具。" })),
      );
      return;
    }

    let turnToolMessages: ToolMessage[] = []; // 本轮工具结果(供反思层算失败信号)
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
      turnToolMessages = toolMessages;
      session.messages.push(...toolMessages);
    } else {
      const toolMessages = await deps.executeToolCalls(toolCalls, deps.registry, toolCtx, deps.gate);
      for (const tc of toolCalls) {
        const m = toolMessages.find((tm) => tm.tool_call_id === tc.id);
        if (m) events.toolResult(tc, m);
      }
      turnToolMessages = toolMessages;
      session.messages.push(...toolMessages);
    }

    // P2-11 编辑后诊断回灌:本轮改了文件 → 跑诊断命令,有报错就注入 [诊断],模型当轮自查自改。
    if (deps.diagnose) {
      const wrote = toolCalls.some((tc) => ["write_file", "edit_file", "multi_edit", "notebook_edit"].includes(tc.function.name));
      if (wrote && !signal?.aborted) {
        const d = await deps.diagnose();
        if (d) { session.messages.push({ role: "system", content: `[诊断:编辑后检查发现问题,请修复]\n${d}` }); events.notice("\n[已注入编辑后诊断]\n"); }
      }
    }

    // L4.2/L4.3 进度评估:本轮有无"实质推进"(写文件/改文件/推进任务清单)。
    // 连续空转或临近上限 → 下一轮注入一次性 advisor 提醒,促其回看目标/收尾/求助,防长程漂移与空耗。
    const progressed = toolCalls.some((tc) => PROGRESS_TOOLS.has(tc.function.name));
    noProgress = progressed ? 0 : noProgress + 1;
    // 提醒【追加】进对话(append-only,缓存安全),而非每轮拼到请求尾部又撤(那会反复废缓存)。
    const advisories: string[] = [];
    if (noProgress > 0 && noProgress % ADVISE_EVERY === 0) {
      advisories.push(`[进度提醒] 已连续 ${noProgress} 轮没有改动文件或推进任务清单。回看 todo 确认方向;若已完成请调用 verify_done 收尾;若卡住请换思路或用 ask_user 向用户求助,不要空转。`);
    }
    if (Number.isFinite(maxTurns) && t === maxTurns - 5) { // 仅在跨入"最后 5 轮"那一刻提醒一次(不每轮刷)
      advisories.push(`[轮数提醒] 接近最大轮数(${t + 1}/${maxTurns}),请尽快收敛并收尾(必要时 verify_done 验收或向用户汇报现状)。`);
    }
    // 反思层:确定性监控判定 → 卡住叫挑战者、长任务漂移叫纠偏者(同模型 fork,命中热缓存);结论作 advisory 参考。
    if (deps.reflect && !signal?.aborted) {
      const fails = turnToolMessages.filter((m) => looksFailed(m.content));
      const outcome = {
        progressed,
        toolFailures: fails.length,
        errSig: fails.length ? errSignature(fails[fails.length - 1]!.content) : undefined,
      };
      const d = assessTurn(health, outcome, healthCfg, { longTask: !!deps.longTask });
      health = d.next;
      if (d.challenger || d.refocuser) {
        events.notice(`\n[反思:${d.challenger ? "审视当前进展" : "纠偏长任务方向"}…]\n`);
        const verdict = await deps.reflect(d.challenger ? "challenger" : "refocuser");
        if (verdict) advisories.push(`[${d.challenger ? "审视者" : "纠偏者"}·参考]\n${verdict}`);
      }
    }
    if (advisories.length) session.messages.push({ role: "system", content: advisories.join(" ") });
  }
  events.notice("\n[已达最大轮数,停止]\n");
}
