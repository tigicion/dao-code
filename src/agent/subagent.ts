import { Session } from "../session/session.js";
import type { ChatMessage } from "../client/types.js";
import type { Mode } from "../tools/tools_for_mode.js";
import type { ToolContext } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ApprovalGate } from "../approval/types.js";
import type { TurnDeps } from "./loop.js";
import type { CacheAuditSink } from "../session/cache_audit.js";

export interface SubagentDeps {
  task: string;
  systemPrompt: string;
  model: string;
  mode: Mode;
  config: { baseUrl: string; apiKey: string };
  registry: ToolRegistry;
  ctx: ToolContext;
  gate: ApprovalGate;
  streamChat: TurnDeps["streamChat"];
  executeToolCalls: TurnDeps["executeToolCalls"];
  write: (s: string) => void;
  runTurn: (deps: TurnDeps) => Promise<void>;
  signal?: AbortSignal; // 父代理 abort 时一并停子代理
  writeTranscript?: (messages: ChatMessage[]) => void; // 子代理转录落盘(sidechain 观测/可恢复)
  drainPending?: () => string[]; // SendMessage:回合边界消费父代理追加的指令
  forkMessages?: ChatMessage[]; // ② fork:用父代理已缓存的消息前缀作起点(复用前缀缓存),task 作末尾指令
  auditSink?: CacheAuditSink; // 指向【根会话】的同一 sink → 子代理记录也写进根 cache.jsonl
  auditAgent?: "sub" | "fork" | "bg"; // 本子代理在树中的身份(默认 sub)
  auditSubId?: string; // 本子代理短 id(用于 agentKey 分桶与渲染)
}

// 一次性派发:全新隔离会话(系统 prompt + task)跑到底,返回最终 assistant 文本。
export async function runSubagent(deps: SubagentDeps): Promise<string> {
  deps.write("\n[子代理开始]\n");
  const sub = new Session(deps.systemPrompt, deps.model);
  sub.mode = deps.mode;
  if (deps.forkMessages && deps.forkMessages.length > 0) {
    // ② fork:继承父代理已缓存前缀(system 在 [0]),末尾追加子任务指令——只此处与父对话不同 → 命中父缓存。
    sub.messages = [...deps.forkMessages];
    sub.addUser(`[fork 子任务:只做这件事并返回结论,不要改动主任务状态] ${deps.task}`);
  } else {
    sub.addUser(deps.task);
  }
  const subDepth = (deps.ctx.subagentDepth ?? 0) + 1;
  await deps.runTurn({
    session: sub,
    config: deps.config,
    registry: deps.registry,
    // 子代理用独立 readFiles(不污染主代理"已读"集合,避免绕过写前须读护栏)。
    ctx: { ...deps.ctx, subagentDepth: subDepth, readFiles: new Set(), readMeta: new Map() },
    gate: deps.gate,
    streamChat: deps.streamChat,
    executeToolCalls: deps.executeToolCalls,
    write: deps.write,
    signal: deps.signal,
    drainPending: deps.drainPending,
    background: true, // 子代理:遇 529 不重试/不回退,防并行子代理级联放大
    selfChallenge: true, // 子代理不另起反思 fork,但跑确定性卡住检测:连续失败/同错复发 → 注入静态自省 nudge
    maxTurns: 200, // 子代理硬上限 200 轮(对标 CC fork subagent);主会话不限轮数靠 compact
    ...(deps.auditSink ? { auditSink: deps.auditSink, auditId: { agent: deps.auditAgent ?? "sub", subId: deps.auditSubId, depth: subDepth } } : {}),
  });
  deps.write("\n[子代理完成]\n");
  try { deps.writeTranscript?.(sub.messages); } catch { /* 落盘失败不影响结果 */ }
  const last = sub.messages[sub.messages.length - 1];
  return last && last.role === "assistant" && typeof last.content === "string" && last.content
    ? last.content
    : "(子代理无最终输出)";
}
