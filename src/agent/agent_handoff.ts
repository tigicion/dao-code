// src/agent/agent_handoff.ts
import type { ChatMessage } from "../client/types.js";
import { buildClassifierTranscript } from "../permissions/classifier.js";

interface ClassifyResult { unavailable?: boolean; shouldBlock?: boolean; reason?: string; }

/**
 * auto 权限模式下,子代理结束后审查其输出是否安全(对标 CC classifyHandoffIfNeeded)。
 * 复用 DAO 现有 buildClassifierTranscript 构建 transcript。
 */
export async function classifyHandoffIfNeeded(opts: {
  agentMessages: ChatMessage[];
  permissionMode: string;  // 审批模式(auto/default/acceptEdits/bypassPermissions)
  abortSignal: AbortSignal;
  subagentType: string;
  totalToolUseCount: number;
  classifyFn?: (transcript: string) => Promise<ClassifyResult>;
}): Promise<string | null> {
  if (opts.permissionMode !== "auto") return null;
  if (opts.agentMessages.length === 0) return null;
  const transcript = buildClassifierTranscript(opts.agentMessages);
  if (!transcript || !opts.classifyFn) return null;
  let result: ClassifyResult;
  try { result = await opts.classifyFn(transcript); }
  catch { return "注意:安全分类器不可用,请手动验证子代理的操作后再信任其结果。"; }
  if (result.unavailable) return "注意:安全分类器不可用,请手动验证子代理的操作后再信任其结果。";
  if (result.shouldBlock) return `安全警告:子代理执行了可能违反安全策略的操作。原因:${result.reason ?? "未知"}。请仔细审查子代理的操作后再信任其输出。`;
  return null;
}
