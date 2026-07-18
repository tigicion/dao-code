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
import type { CacheAuditSink, CacheAuditInput } from "../session/cache_audit.js";
import type { Session } from "../session/session.js";
import { getLang } from "../i18n/i18n.js";
import { apiToolsForMode } from "../tools/tools_for_mode.js";
import { consumeStream, plainEvents, type TurnEvents } from "../tui/render.js";
import { isContextLengthError, isRateLimitError } from "../client/client.js";
import { looksFailed } from "../tools/execute.js";
import { assessTurn, initHealth, errSignature, defaultHealthConfig } from "./turn_health.js";
import { SELF_CHALLENGE_NUDGE } from "./reflect_prompts.js";

// 廉价稳定哈希(djb2):只用于"是否变化"的缓存归因指纹,不求抗碰撞。
function cheapHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// 兜底防线(即便加大了 max_tokens,极端情况——单次输出仍超预算——还是可能截断):
// tool_call 的 arguments 半截/非法 JSON 不能原样存进历史。dispatch 执行时会按原始内容
// 报"invalid JSON arguments"(信息不变),但【落库】版本换成合法占位符"{}",防止这条坏
// 消息在后续每一轮被重发时,被某些校验更严格的 provider(如 ARK)判定成 400 Invalid request body。
function sanitizeForHistory(assistant: AssistantMessage): AssistantMessage {
  if (!assistant.tool_calls?.length) return assistant;
  const isValidJson = (s: string): boolean => { try { JSON.parse(s || "{}"); return true; } catch { return false; } };
  if (assistant.tool_calls.every((tc) => isValidJson(tc.function.arguments))) return assistant;
  return {
    ...assistant,
    tool_calls: assistant.tool_calls.map((tc) =>
      isValidJson(tc.function.arguments) ? tc : { ...tc, function: { ...tc.function, arguments: "{}" } },
    ),
  };
}

// 同一道防线,用于【续写/恢复】场景:这条防线只清洗"本进程接下来新生成"的消息,不覆盖
// "续写时从磁盘加载进来的旧历史"——真实撞见过:一个跑着旧代码(无清洗逻辑)、迟迟没重启的
// 进程最终把半截 JSON 的消息存进了 state.json,之后用修复后的新版 dao 续写这个会话,
// 等于把这条已经写死在磁盘上的坏消息重新加载了回来,清洗对它完全不生效。索引/导出给
// index.ts 在 resume(--continue/-c 与 /resume <id>)时对整份历史也过一遍。
export function sanitizeHistoryForResume(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => (m.role === "assistant" ? sanitizeForHistory(m) : m));
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
  // reasoning effort 覆盖(子代理 agentDef.effort 传入);省略则用全局 DAO_REASONING_EFFORT。
  reasoningEffort?: string;
  // 中途取消信号(ESC/超时):透传给 streamChat 与工具 ctx;abort 后本回合优雅停止。
  signal?: AbortSignal;
  // 回合边界消费的追加消息(SendMessage 给运行中子代理用):每个工具回合前注入为 user 消息。
  drainPending?: () => string[];
  // 回合边界注入的 advisory(system 角色);用于异步挑战者结论"本回合内尽量接住"。省略=不注入。
  drainAdvisories?: () => string[];
  // 回合边界注入的后台子代理完成结果(user 角色):自主长任务(单个大 runTurn)中也能及时拿到,
  // 不必等整轮跑完才回灌——修复 headless/--goal 下后台结果丢失。省略=不处理(行为同旧版)。
  drainNotifications?: () => string[];
  // L2.2 反应式压缩:streamChat 报"上下文超限"时调用它压缩后重试本轮(估算阈值之外的安全网)。
  compact?: () => Promise<void>;
  // §4 轮内主动压缩:每个工具轮前若返回 true 则先 compact()——防长回合中途撞上限(粒度到工具轮)。
  shouldCompact?: () => boolean;
  // L1.3 模型回退:主模型持续过载/异常时,本回合临时改用此模型跑完(如 flash)。省略=不回退。
  fallbackModel?: string;
  // 限流菜单用:返回除当前激活账号外的全部账号名(交互场景,配合 askChoice 里的"切到账号 X"选项)。
  // 省略/返回空数组 = 菜单不出现账号切换选项,行为同现状。
  listOtherAccounts?: () => { name: string }[];
  // 切到指定账号并【等凭据真正解析完成】才返回(不能 fire-and-forget,否则切换后立刻重试会用错 apiKey)。
  // false = 账号不存在或凭据解析失败。
  switchAccountAndWait?: (name: string) => Promise<boolean>;
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
  // 子代理自挑战:子代理不传 reflect(不另起 fork,避免嵌套加深/翻倍成本/废前缀缓存),
  // 但仍跑廉价的确定性卡住检测——卡住时注入一段静态自省 nudge,让子代理在自己下一轮里反省。
  selfChallenge?: boolean;
  // 每个工具轮结束后调用一次(存档用):此前只在【整个用户回合】跑完才落盘一次(index.ts 的
  // persist()),回合中途崩溃(如触发了某个未预料的 API 错误)会连带丢掉这一整个回合里此前
  // 已经成功的所有工具调用——哪怕只有最后一步真正出了问题。省略=不额外存档(子代理/一次性
  // 运行没有独立会话文件,不需要这层)。
  onCheckpoint?: () => void;
}

// 在已有的 session.messages 上跑一个用户回合,直到模型不再请求工具。
export async function runTurn(deps: TurnDeps): Promise<void> {
  const { session, signal } = deps;
  const events = deps.events ?? plainEvents(deps.write);
  // 工具 ctx 透传取消信号(Bash 据此 SIGTERM);不改原 ctx 引用,按需补 signal + 当前模型名。
  const toolCtx = { ...deps.ctx, sessionModel: session.model, ...(signal ? { signal } : {}) };
  // 边界保护对标 CC:纯量化——主会话不限轮数(undefined→Infinity,靠 token 预算触发 compact),
  // 子代理传 200。DAO_MAX_TURNS 仍作硬上限覆盖(eval/自动化用)。无质化卡死检测。
  const maxTurns = deps.maxTurns ?? (Number(process.env.DAO_MAX_TURNS) || Infinity);
  // L4.2/L4.3 进度追踪 + advisor 提醒:长任务空转/临近上限时,把提醒【追加】进 session.messages(append-only)。
  const ADVISE_EVERY = Number(process.env.DAO_ADVISE_EVERY) || 5;
  const PROGRESS_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "TodoWrite"]);
  let noProgress = 0;
  // 同一次"卡住"期间已经提过几次醒(progressed 一旦为真就跟 noProgress 一起清零)。
  // 动机:蒸馏过 4 道 terminal-bench 超时题(dna-assembly/llm-inference-batching-scheduler/
  // raman-fitting/rstan-to-pystan)后发现同一个反模式——遇到不确定的点(某个坐标/公式/参数)
  // 反复用文字重新推导,而不是写一段脚本/跑一条命令直接算出确定答案。首次提醒用通用措辞就够;
  // 但如果同一次卡住反复触发(提醒过还是没推进),说明通用措辞没起作用,该换成更具体地
  // 点破"停止文字循环、换成能拿到确定结果的动作"这条,而不是一直重复同一句没用的话。
  let stuckAdviceCount = 0;
  // 全会话累计"通用档提醒"触发次数,不随 progressed 清零(与 stuckAdviceCount 的区别就在这里)。
  // 动机(真实撞见:terminal-bench make-mips-interpreter,反复推理反模式):模型卡在同一个
  // printf/内存字节问题上反复假设了两个多小时,期间进度提醒确实触发过 3 次,但每次都恰好被
  // 穿插的零星 Edit 调用清零了 stuckAdviceCount,导致每次都只拿到"第1次"的通用措辞,
  // 从未真正升级——跟 raman-fitting 那次发现的检测盲区同一个根因("该轮是否调用过写类工具"
  // 不代表核心问题真的被解决了)。这个计数器不看"当前这次卡住连续了几次",看"这整个会话
  // 里已经卡住又被复位过几次",复位掩盖不了这个累计数字。
  let totalStuckEvents = 0;
  // 反思层:确定性回合监控状态(跨本 runTurn 的各模型回合累积)。
  let health = initHealth();
  const healthCfg = defaultHealthConfig();

  // 一次"请求模型"的韧性封装:封装流式 + 反应式压缩重试 + 模型回退,失败才上抛(error withholding)。
  const reasoningEffort = deps.reasoningEffort ?? process.env.DAO_REASONING_EFFORT ?? "max";
  const requestAssistant = async (tools: ReturnType<typeof apiToolsForMode>, turn: number): Promise<AssistantMessage> => {
    let ctxRetries = 0; // 本轮反应式压缩次数上限,防压不动时死循环
    let usedFallback = false;
    let hardRetries = 0; // 主模型+回退模型都遇到同类网络/超时错误后,退避重试整轮的次数上限
    let rateLimitRetries = 0; // 限流后"等待重试"选了几次(非交互场景下也当退避上限用)
    const rateLimitMaxRetries = Number(process.env.DAO_RATE_LIMIT_MAX_RETRIES) || 5;
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
              // msgs=本次实发消息体 → distill 据此比对前缀是否逐字节一致(诊断 0.52 命中之谜)。
              ...(deps.auditId?.agent === "main" ? { msgs: JSON.stringify(sent) } : {}),
            });
          },
          // finish_reason=content_filter:服务端内容过滤拦截,返回一句通用拒答文案("作为一个
          // 人工智能语言模型，我还没学习如何回答这个问题...")——语义上是"被拦截了",不是"模型
          // 真的不知道怎么答",混在正常回合里完全看不出区别。真实撞见过 terminal-bench
          // password-recovery/protein-assembly 两个任务命中,当时毫无痕迹,只能靠事后手工
          // replay 复现才查出真相(见 evolution-log.md)。这里加一条明确可见的提示,不改变
          // 任何裁决/重试逻辑——这类拦截是服务端策略决定的,同样的输入原样重发也是同样结果
          // (已用 replay 验证过是确定性的,不是偶发抖动),重试没有意义,只做可观测性。
          onFinishReason: (r) => {
            if (r === "content_filter") events.notice("\n[⚠ 本轮回复被服务端内容过滤拦截(finish_reason=content_filter),不是模型真实的回答]\n");
          },
          onEmptyTruncation: () => { emptyTruncation = true; },
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
        const msg = e instanceof Error ? e.message : String(e);
        const rateLimited = isRateLimitError(e);
        // 过载/5xx/超时/网络类:client.ts 自己的流式重试+非流式兜底已经耗尽才会到这里,
        // 包成"连接…失败"/"非流式…均失败"这类文案。
        const genericRecoverable = /5\d\d|overload|529|timeout|超时|连接.*失败|网络|非流式/i.test(msg);

        // 交互场景(ctx.askChoice 存在):任何"看起来能恢复"的故障都不自动重试/自动换模型——
        // 原样把错误报给用户 + 给出可选动作,由用户决定接下来怎么办。子代理(background)没有
        // 交互能力,不问,直接走下面 headless 分支(同其余分支对 background 的一贯处理)。
        if (!deps.background && (rateLimited || genericRecoverable) && deps.ctx.askChoice) {
          events.notice(`\n[⚠ 请求失败] ${msg}\n`);
          const canOfferFallback = !rateLimited && !!deps.fallbackModel && !usedFallback;
          // 限流时菜单动态列出除当前账号外的全部账号(不猜"最合适的",账号数量不定时都摆出来,用户自己选)。
          const accountOptions = rateLimited
            ? (deps.listOtherAccounts?.() ?? []).map((a) => ({ label: `切到账号「${a.name}」重试`, name: a.name }))
            : [];
          const options = [
            "等待后用当前模型重试",
            ...(canOfferFallback ? [`换成备用模型「${deps.fallbackModel}」试试(本回合)`] : []),
            ...accountOptions.map((o) => o.label),
            rateLimited ? "中止本轮(稍后可用 /account 切换账号)" : "中止本轮",
          ];
          const choice = await deps.ctx.askChoice(
            rateLimited
              ? "当前账号触发限流(请求频率/配额超限)。接下来怎么办?"
              : "请求持续失败(疑似过载/超时/网络问题)。接下来怎么办?",
            options,
          );
          if (choice.startsWith("等待")) {
            rateLimitRetries++;
            const rateLimitBaseWaitMs = Number(process.env.DAO_RATE_LIMIT_WAIT_MS) || 5000;
            const waitMs = Math.min(rateLimitBaseWaitMs * rateLimitRetries, 30000);
            events.notice(`\n[等待 ${Math.round(waitMs / 1000)}s 后重试(仍用当前模型,不降级)…]\n`);
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          if (canOfferFallback && choice.startsWith("换成备用模型")) {
            usedFallback = true;
            events.notice(`\n[已按你的选择临时切到 ${deps.fallbackModel}…]\n`);
            continue;
          }
          // 切账号是持久的(等同手动 /account),不是"仅本轮"——账号被限流之后没理由下一轮切回去。
          const matchedAccount = accountOptions.find((o) => o.label === choice);
          if (matchedAccount && deps.switchAccountAndWait) {
            const ok = await deps.switchAccountAndWait(matchedAccount.name);
            if (ok) {
              events.notice(`\n[已切换到账号「${matchedAccount.name}」,继续重试…]\n`);
              continue;
            }
            // 失败不静默吞掉、不重试同账号(会立刻再撞同一个 429)——落到下面的 throw,把切换失败的原因和
            // 原始限流错误一起交给用户,而不是悄悄回到等待/中止的选项让用户自己再猜一次发生了什么。
            events.notice(`\n[切换到账号「${matchedAccount.name}」失败(账号不存在或凭据解析失败),仍在原账号]\n`);
          }
          throw new Error(
            `已中止:${rateLimited ? "当前账号触发限流(请求频率/配额超限)。可运行 /account 切换到其它账号后重新发送消息。" : "已按你的选择中止本轮。"}\n原始错误:${msg}`,
          );
        }

        // ---- 以下:非交互场景(headless/--goal/eval,无 ctx.askChoice)保留原有自动恢复 ----
        // 没有人能回答问题,只能自动决定,是专门为无人值守长任务做的健壮性兜底。

        // 限流:自动等待退避重试(不换模型),超过上限才放弃——不无限等待。
        if (!deps.background && rateLimited) {
          if (rateLimitRetries < rateLimitMaxRetries) {
            rateLimitRetries++;
            const rateLimitBaseWaitMs = Number(process.env.DAO_RATE_LIMIT_WAIT_MS) || 5000;
            const waitMs = Math.min(rateLimitBaseWaitMs * rateLimitRetries, 30000);
            events.notice(`\n[限流,等待 ${Math.round(waitMs / 1000)}s 后重试(不降级,第 ${rateLimitRetries}/${rateLimitMaxRetries} 次)…]\n`);
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          throw new Error(`已中止:当前账号触发限流(请求频率/配额超限)。可运行 /account 切换到其它账号后重新发送消息。\n原始错误:${msg}`);
        }
        // L1.3 模型回退:过载/5xx/网络类异常 → 本回合临时换 fallback 模型再试一次。
        if (!deps.background && deps.fallbackModel && !usedFallback && genericRecoverable) {
          usedFallback = true;
          events.notice(`\n[主模型异常,本回合临时回退 ${deps.fallbackModel}…]\n`);
          continue;
        }
        // 主模型+回退模型都遇到了同类网络/超时错误(真实撞见过 terminal-bench make-mips-interpreter:
        // 模型试图单次 Write 写入千行级大文件,主模型先抛异常触发回退,回退模型随后也 120s 空闲
        // 超时——此前这里直接上抛,整个 episode 崩溃退出,900s+ 预算和此前所有真实进展全部作废)。
        // 退避后把 usedFallback 重置、给主模型再来一次机会,最多重试 2 次,任何一次成功都救回本轮。
        const hardMaxRetries = 2;
        if (!deps.background && hardRetries < hardMaxRetries && genericRecoverable) {
          hardRetries++;
          usedFallback = false;
          events.notice(`\n[主备模型均异常,退避后整轮重试(第 ${hardRetries}/${hardMaxRetries} 次)…]\n`);
          const hardRetryDelayMs = Number(process.env.DAO_HARD_RETRY_DELAY_MS) || 1000;
          await new Promise((r) => setTimeout(r, hardRetryDelayMs * hardRetries));
          continue;
        }
        throw e; // 恢复手段用尽:上抛(致命或网络彻底不通)
      }
    }
  };

  let budgetWarned = false;
  let emptyTruncation = false; // 本次 requestAssistant 是否命中"reasoning 耗尽预算、content 全程为空"
  for (let t = 0; t < maxTurns; t++) {
    if (signal?.aborted) return; // 上一轮工具执行后被取消,直接收尾
    // P3-17 预算【可选提醒】:设了 budgetCNY 且累计成本超过它 → 提醒一次(不停);
    // 仅当显式 DAO_MAX_BUDGET_HARD=1 才硬停。默认不拦,把决定权留给用户。
    if (session.overBudget()) {
      if (!budgetWarned) { budgetWarned = true; events.notice(`\n[成本提醒] 本会话累计约 ¥${session.costCNY().toFixed(2)},已超阈值 ¥${session.budgetCNY}。\n`); }
      if (process.env.DAO_MAX_BUDGET_HARD === "1") { events.notice(`[已达硬预算上限,停止]\n`); return; }
    }
    // §4 轮内主动压缩:长回合中途逼近上限 → 先压再进下一轮(粒度到工具轮,不等回合末)。
    // t>0:首轮的入口大小已由回合间压缩兜过,只处理本回合内增长。
    if (t > 0 && deps.compact && deps.shouldCompact?.()) {
      events.notice("\n[轮内接近上限,自动压缩…]\n");
      await deps.compact();
    }
    // SendMessage/运行中排队输入:回合边界消费追加的指令(注入为 user 消息)。userMessage 事件让渲染层
    // 在真正注入的这一刻(而不是用户敲回车排队的那一刻)才展示,时间点对得上模型实际看到它的时机。
    if (deps.drainPending) {
      for (const m of deps.drainPending()) {
        session.messages.push({ role: "user", content: `[追加指令] ${m}` });
        events.userMessage?.(m);
      }
    }
    // 异步挑战者结论:回合边界 drain 注入为 system advisory(本回合内接住即当轮生效)。
    // 注入时给用户可见提示(与失败式挑战者的 events.notice 一致),否则路径①静默、无从感知。
    if (deps.drainAdvisories) {
      for (const a of deps.drainAdvisories()) {
        events.notice("\n[反思:审视者介入…]\n");
        session.messages.push({ role: "system", content: a });
      }
    }
    // 后台子代理完成结果:回合边界 drain 注入为 user 消息。放在工具轮边界(而非仅整轮末)
    // 才能让自主长任务(单个大 runTurn)中途也拿到后台结果,修复 headless/--goal 下结果丢失。
    if (deps.drainNotifications) {
      const notes = deps.drainNotifications();
      if (notes.length) {
        events.notice(`\n[↩ 收到 ${notes.length} 个后台任务结果]\n`);
        for (const n of notes) session.messages.push({ role: "user", content: `[后台任务结果]\n${n}` });
      }
    }
    const tools = apiToolsForMode(deps.registry, session.mode, getLang());
    emptyTruncation = false;
    let assistant = await requestAssistant(tools, t);
    let toolCalls = assistant.tool_calls ?? [];
    let hasContent = typeof assistant.content === "string" && assistant.content.trim().length > 0;
    // 用户中途取消(ESC)、且这一轮确实空手而归(无 content 无 tool_calls):client.ts 对
    // "abort 时尚无产出"故意不抛错,优雅返回一个空 assistant 消息(见 client.ts isAbort 分支),
    // 避免半截工具调用把历史搞崩。但这意味着下面的空响应重试逻辑会误把"被打断"当成
    // "模型真答不出",在用户已经按了 ESC 之后又真的发一次网络请求(该请求同样立刻被 abort
    // 返回空),白等一轮往返,还甩出两条"模型空响应/连续两次空响应"的误导性提示——这里直接
    // 收尾。注意:只在真空手时提前退出;若这一轮已经有 content/tool_calls(答完/工具调用后
    // 才 abort),必须继续走下面的正常入库 + 补齐取消态 tool 结果流程,不能跳过。
    if (signal?.aborted && toolCalls.length === 0 && !hasContent) return;
    // 空内容且无工具调用的回合(只有 reasoning、或被打断)不能直接入库——否则下一轮
    // DeepSeek 会 400「content or tool_calls must be set」直接崩会话。但也不能悄悄当成
    // "模型主动决定收尾了"就地结束:蒸馏过 iteration 4 两道题(large-scale-text-editing、
    // winning-avg-corewars)发现,这种情况实际是模型陷入了长时间未收敛的推理(反复
    // "wait,这不对…让我重新想想"那种),最后一轮没能收敛出结论或动作,返回了空响应——
    // 不是真的没有更多要做的了。之前直接 return 会把"没说完"悄悄当成"说完了",且没有
    // 任何可观测的痕迹,一次性/eval 场景下这类情况会被误判成模型"想清楚了但做错了"的
    // 干净失败,掩盖了真实问题。改成重试一次(不入库这次的空响应,原样重发相同的
    // session.messages);仍是空的才真正结束,但留一条可见提示,不再无声无息消失。
    if (toolCalls.length === 0 && !hasContent) {
      // reasoning 耗尽整个输出预算(client.ts 的 onEmptyTruncation)是空响应的一个具体子类:
      // 原样重发大概率再次把预算耗在同一段思考上(真实撞见过 gpt2-codegolf/
      // model-extraction-relu-logits 两题,均连续两轮如此、直接终止 session)。这种情况下
      // 注入一条收敛提示再重试,而不是盲目原样重发。
      const wasEmptyTruncation = emptyTruncation;
      if (wasEmptyTruncation) {
        events.notice("\n[思考耗尽输出预算,提示收敛后重试…]\n");
        session.messages.push({
          role: "system",
          content: "[提示] 上一轮的思考过程用尽了输出预算,还没有给出最终回答或工具调用就被截断。" +
            "这一轮请更快收敛:如果方向已经想清楚,直接给出结论、代码或调用工具,不要重新从头展开完整推导。",
        });
      } else {
        events.notice("\n[模型返回空响应,重试一次…]\n");
      }
      emptyTruncation = false;
      assistant = await requestAssistant(tools, t);
      toolCalls = assistant.tool_calls ?? [];
      hasContent = typeof assistant.content === "string" && assistant.content.trim().length > 0;
      if (toolCalls.length === 0 && !hasContent) {
        events.notice("\n[连续两次空响应,结束本轮]\n");
        return;
      }
    }
    // 执行仍用原始 assistant/toolCalls(dispatch 报错信息不受影响);落库换成清洗过的版本。
    session.messages.push(sanitizeForHistory(assistant));
    if (toolCalls.length === 0) {
      return; // 纯文本回合(含被打断只剩 content):直接结束
    }
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

    // 工具返回了图片 → 在 tool messages 后注入一条 user message 携带 image_url。
    // 千帆等 OpenAI 兼容 API 的 tool role 不接受 content 数组,故图片走 user message(对标 Kimi 文档的多模态格式)。
    const imageParts = turnToolMessages
      .filter((m) => m.imageData)
      .map((m) => ({ type: "image_url" as const, image_url: { url: `data:${m.imageData!.mediaType};base64,${m.imageData!.base64}` } }));
    if (imageParts.length > 0) {
      session.messages.push({ role: "user", content: [...imageParts, { type: "text", text: "[以上图片由 Read 工具读取,请基于图片内容回答用户的问题]" }] });
    }

    // P2-11 编辑后诊断回灌:本轮改了文件 → 跑诊断命令,有报错就注入 [诊断],模型当轮自查自改。
    if (deps.diagnose) {
      const wrote = toolCalls.some((tc) => ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tc.function.name));
      if (wrote && !signal?.aborted) {
        const d = await deps.diagnose();
        if (d) { session.messages.push({ role: "system", content: `[诊断:编辑后检查发现问题,请修复]\n${d}` }); events.notice("\n[已注入编辑后诊断]\n"); }
      }
    }

    // L4.2/L4.3 进度评估:本轮有无"实质推进"(写文件/改文件/推进任务清单)。
    // 连续空转或临近上限 → 下一轮注入一次性 advisor 提醒,促其回看目标/收尾/求助,防长程漂移与空耗。
    const progressed = toolCalls.some((tc) => PROGRESS_TOOLS.has(tc.function.name));
    if (progressed) { noProgress = 0; stuckAdviceCount = 0; } else { noProgress++; }
    // 提醒【追加】进对话(append-only,缓存安全),而非每轮拼到请求尾部又撤(那会反复废缓存)。
    const advisories: string[] = [];
    if (noProgress > 0 && noProgress % ADVISE_EVERY === 0) {
      stuckAdviceCount++;
      totalStuckEvents++;
      // 首次(且本会话此前也没反复卡住过):通用措辞。第2次起同一次卡住还没缓解,或者
      // 虽然这次是"第1次"但本会话已经因零星编辑被清零过好几回(totalStuckEvents 够高)
      // → 说明通用措辞没用或者一直在被规避检测,换成直接点破"別再文字循环、换成能拿到
      // 确定结果的动作"这条更具体的建议。
      const escalate = stuckAdviceCount > 1 || totalStuckEvents >= 3;
      advisories.push(
        !escalate
          ? `[进度提醒] 已连续 ${noProgress} 轮没有改动文件或推进任务清单。如果你在反复用文字重新推导同一个不确定的点(某个数值/坐标/参数/配置该怎么定),现在就停下来,换成一个能给出确切答案的动作代替继续假设——写脚本算出来、跑命令查、或读文档确认,拿到确定结果再往下走,不要继续在文字里循环论证同一个问题;哪怕设计还没完全想清楚,也先写一个不完整的最小版本落地,让验证暴露剩下的问题。如果已经完成,请派 verify 子代理验证后收尾;如果确实卡住了,用 AskUserQuestion 向用户求助,不要空转。`
          : stuckAdviceCount > 1
            ? `[进度提醒·第${stuckAdviceCount}次] 已连续 ${noProgress} 轮没有改动文件或推进任务清单,前面提醒过 ${stuckAdviceCount - 1} 次仍没有推进——这通常意味着你还在原地用文字重新论证同一个问题。现在必须切换成具体动作:写脚本算出来、跑命令查、或读文档确认,拿到确定结果再往下走,不要继续在文字里循环论证;哪怕设计还没完全想清楚,也先写一个不完整的最小版本落地。如果确实卡住了,用 AskUserQuestion 求助或如实汇报现状。`
            : `[进度提醒·本会话第${totalStuckEvents}次卡住] 已连续 ${noProgress} 轮没有改动文件或推进任务清单。本次会话此前已经出现过类似的"卡住"状态、中途靠零星的文件修改把计数器复位过——复位不代表核心问题真的解决了,如果你还在对同一个具体问题(某个字节/寄存器/配置的实际值)反复假设,现在必须写一个最小验证脚本或加一行调试打印直接拿到确定答案,不要满足于"又推进了一点"就继续用文字重新假设。如果确实卡住了,用 AskUserQuestion 求助或如实汇报现状。`,
      );
      const label = stuckAdviceCount > 1 ? `·第${stuckAdviceCount}次` : escalate ? `·本会话第${totalStuckEvents}次卡住` : "";
      events.notice(`\n[进度提醒${label}:已连续 ${noProgress} 轮无实质推进]\n`);
    }
    if (Number.isFinite(maxTurns) && t === maxTurns - 5) { // 仅在跨入"最后 5 轮"那一刻提醒一次(不每轮刷)
      advisories.push(`[轮数提醒] 接近最大轮数(${t + 1}/${maxTurns}),请尽快收敛并收尾(必要时派 verify 子代理验证或向用户汇报现状)。`);
      events.notice(`\n[轮数提醒:接近最大轮数 ${t + 1}/${maxTurns}]\n`);
    }
    // 反思层:确定性监控判定 → 卡住叫挑战者、长任务漂移叫纠偏者。检测(廉价纯函数)与应对(贵的 LLM)解耦:
    //   · 主回合(有 reflect)→ 起一个 fork 独立复核,结论作 advisory(命中热缓存)。
    //   · 子代理(无 reflect、selfChallenge=true)→ 不 fork,注入静态自省 nudge,让它就地反省。
    if ((deps.reflect || deps.selfChallenge) && !signal?.aborted) {
      const fails = turnToolMessages.filter((m) => looksFailed(typeof m.content === "string" ? m.content : ""));
      const outcome = {
        progressed,
        toolFailures: fails.length,
        errSig: fails.length ? errSignature(typeof fails[fails.length - 1]!.content === "string" ? fails[fails.length - 1]!.content as string : "") : undefined,
      };
      const d = assessTurn(health, outcome, healthCfg, { longTask: !!deps.longTask });
      health = d.next;
      if (deps.reflect && (d.challenger || d.refocuser)) {
        events.notice(`\n[反思:${d.challenger ? "审视当前进展" : "纠偏长任务方向"}…]\n`);
        const verdict = await deps.reflect(d.challenger ? "challenger" : "refocuser");
        if (verdict) advisories.push(`[${d.challenger ? "审视者" : "纠偏者"}]\n${verdict}`);
      } else if (deps.selfChallenge && d.challenger) {
        // 子代理只对"卡住"(失败/同错)自省;纠偏(长任务漂移)对单一受限子任务无意义,不触发。
        events.notice(`\n[子代理自检:连续失败,促其反省前提…]\n`);
        advisories.push(SELF_CHALLENGE_NUDGE);
      }
    }
    if (advisories.length) session.messages.push({ role: "system", content: advisories.join(" ") });
    // 每个工具轮落一次盘:即便下一轮请求异常上抛(如触发了未预料的 API 错误)导致整个回合
    // 没能跑完,这一轮及之前已经成功的工具调用也不会连带作废——回合末的 persist() 只是
    // 再确认一次最终状态,不是唯一一次存档。
    deps.onCheckpoint?.();
  }
  events.notice("\n[已达最大轮数,停止]\n");
}
