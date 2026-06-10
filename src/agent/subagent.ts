import { Session } from "../session/session.js";
import type { ChatMessage } from "../client/types.js";
import type { Mode } from "../tools/tools_for_mode.js";
import type { ToolContext } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ApprovalGate } from "../approval/types.js";
import type { TurnDeps } from "./loop.js";

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
}

// 一次性派发:全新隔离会话(系统 prompt + task)跑到底,返回最终 assistant 文本。
export async function runSubagent(deps: SubagentDeps): Promise<string> {
  deps.write("\n[子代理开始]\n");
  const sub = new Session(deps.systemPrompt, deps.model);
  sub.mode = deps.mode;
  sub.addUser(deps.task);
  await deps.runTurn({
    session: sub,
    config: deps.config,
    registry: deps.registry,
    // 子代理用独立 readFiles(不污染主代理"已读"集合,避免绕过写前须读护栏)。
    ctx: { ...deps.ctx, subagentDepth: (deps.ctx.subagentDepth ?? 0) + 1, readFiles: new Set() },
    gate: deps.gate,
    streamChat: deps.streamChat,
    executeToolCalls: deps.executeToolCalls,
    write: deps.write,
    signal: deps.signal,
    drainPending: deps.drainPending,
  });
  deps.write("\n[子代理完成]\n");
  try { deps.writeTranscript?.(sub.messages); } catch { /* 落盘失败不影响结果 */ }
  const last = sub.messages[sub.messages.length - 1];
  return last && last.role === "assistant" && typeof last.content === "string" && last.content
    ? last.content
    : "(子代理无最终输出)";
}
