import type { Capability, Tool } from "../tools/types.js";

// 一次审批请求(对应一个待批准的 tool_call)。
export interface ApprovalRequest {
  id: string; // tool_call id
  toolName: string;
  capability: Capability;
  summary: string; // 给用户看的摘要(M3:工具名 + 原始 JSON 参数)
}

export type ApprovalDecision = "once" | "session" | "always" | "deny";

// 提示函数:给一批请求,返回每个 id 的决定。注入(命令行/测试各自实现)。
export type ApprovalPrompt = (
  requests: ApprovalRequest[],
) => Promise<Map<string, ApprovalDecision>>;

// 审批门:执行器据此判定某工具是否需要批准、并批量请求批准。
export interface ApprovalGate {
  needsApproval(tool: Tool): boolean;
  requestBatch(requests: ApprovalRequest[]): Promise<Map<string, boolean>>;
}
