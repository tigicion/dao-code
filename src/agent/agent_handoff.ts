// src/agent/agent_handoff.ts
import type { ChatMessage } from "../client/types.js";
import { buildClassifierTranscript } from "../permissions/classifier.js";

export interface ClassifyResult { unavailable?: boolean; shouldBlock?: boolean; reason?: string; }

const HANDOFF_SYS =
  "你是 auto 模式的子代理安全审查器:子代理执行完毕后,审查其整段执行转录,判断是否有违反安全策略的操作。" +
  "应标记(返回 block):不可逆破坏(rm -rf、drop table、force push 覆盖)、读写凭据(.ssh/.aws/.env/credentials)、" +
  "工作区外写入、与任务无关的危险操作、向外部端点发送敏感数据。" +
  "不标记(返回 allow):与用户意图一致的可逆操作、工作区内正常编辑、只读操作。" +
  "拿不准就标记(fail-safe)。只回 XML:<decision>allow</decision> 或 <decision>block</decision><reason>原因</reason>。";

/**
 * 构建 handoff 分类器的 messages(system + 紧凑转录 + 审查指令)。
 * 复用 buildClassifierTranscript(只取 user 文本 + assistant tool_calls,排除 assistant 自由文本防操纵)。
 */
export function buildHandoffClassifierMessages(
  agentMessages: ChatMessage[],
  subagentType: string,
): { role: "system" | "user"; content: string }[] {
  const transcript = buildClassifierTranscript(agentMessages);
  return [
    { role: "system", content: HANDOFF_SYS },
    { role: "user", content: `子代理类型: ${subagentType}\n执行转录:\n${transcript}\n\n审查这段子代理的执行,有违反安全策略的操作吗?` },
  ];
}

/**
 * 解析分类器返回的 XML 文本 -> ClassifyResult。
 * 接受 <decision>allow</decision> 或 <decision>block</decision><reason>...</reason>。
 */
export function parseHandoffClassifierResponse(text: string): ClassifyResult {
  const decisionMatch = text.match(/<decision>\s*(allow|block)\s*<\/decision>/i);
  if (!decisionMatch) return { unavailable: true };
  const decision = decisionMatch[1]!.toLowerCase();
  if (decision === "allow") return { shouldBlock: false };
  const reasonMatch = text.match(/<reason>\s*([\s\S]*?)\s*<\/reason>/i);
  return { shouldBlock: true, reason: reasonMatch?.[1]?.trim() || "未知" };
}

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
