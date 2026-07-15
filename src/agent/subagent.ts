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
  // 并发子代理共享同一个 write() 输出通道(headless/eval 模式下就是 dao_stdout.txt 的底层
  // 写入函数)——`agent` 工具的 capability 是 "plan",在 execute.ts 的安全并发批次里会被
  // 多个一起 Promise.all 跑,多个子代理各自流式 write() 时没有互斥,逐 delta 交织写入同一个
  // 流,真实撞见过(protein-assembly 任务 4 个子代理并发)输出被打散拼接成乱码,一段蛋白质
  // 序列跟另一段不相关的搜索策略描述逐词交错。子代理各自的 sub.messages 是独立 Session、
  // 不受这个通道影响(不影响正确性),但 transcript 可读性/可调试性被破坏。
  // 修法:本子代理跑的全过程只攒本地 buffer,不直接写共享通道;跑完再整体一次性 flush——
  // 单次 write() 调用把交织的窗口从"每个 delta"收窄到"两次子代理各自 flush 之间"的间隙,
  // 消灭掉逐 token 级别的乱序拼接。代价是本子代理运行期间父级看不到它的实时流式输出,
  // 只有它跑完那一刻才整段可见——多子代理并发场景下这个取舍是合理的。
  const buf: string[] = [];
  await deps.runTurn({
    session: sub,
    config: deps.config,
    registry: deps.registry,
    // 子代理用独立 readFiles(不污染主代理"已读"集合,避免绕过写前须读护栏)。
    ctx: { ...deps.ctx, subagentDepth: subDepth, readFiles: new Set(), readMeta: new Map() },
    gate: deps.gate,
    streamChat: deps.streamChat,
    executeToolCalls: deps.executeToolCalls,
    write: (s) => buf.push(s),
    signal: deps.signal,
    drainPending: deps.drainPending,
    background: true, // 子代理:遇 529 不重试/不回退,防并行子代理级联放大
    selfChallenge: true, // 子代理不另起反思 fork,但跑确定性卡住检测:连续失败/同错复发 → 注入静态自省 nudge
    maxTurns: 200, // 子代理硬上限 200 轮(对标 CC fork subagent);主会话不限轮数靠 compact
    ...(deps.auditSink ? { auditSink: deps.auditSink, auditId: { agent: deps.auditAgent ?? "sub", subId: deps.auditSubId, depth: subDepth } } : {}),
  });
  if (buf.length) deps.write(buf.join(""));
  deps.write("\n[子代理完成]\n");
  try { deps.writeTranscript?.(sub.messages); } catch { /* 落盘失败不影响结果 */ }
  const last = sub.messages[sub.messages.length - 1];
  return last && last.role === "assistant" && typeof last.content === "string" && last.content
    ? last.content
    : "(子代理无最终输出)";
}
