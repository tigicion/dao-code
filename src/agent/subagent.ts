import { Session } from "../session/session.js";
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
    ctx: { ...deps.ctx, subagentDepth: (deps.ctx.subagentDepth ?? 0) + 1 },
    gate: deps.gate,
    streamChat: deps.streamChat,
    executeToolCalls: deps.executeToolCalls,
    write: deps.write,
  });
  deps.write("\n[子代理完成]\n");
  const last = sub.messages[sub.messages.length - 1];
  return last && last.role === "assistant" && typeof last.content === "string" && last.content
    ? last.content
    : "(子代理无最终输出)";
}
