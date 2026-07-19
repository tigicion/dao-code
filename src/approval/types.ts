import type { Capability, Tool } from "../tools/types.js";

// 一次审批请求(对应一个待批准的 tool_call)。
export interface ApprovalRequest {
  id: string; // tool_call id
  toolName: string;
  capability: Capability;
  summary: string; // 给用户看的摘要(人类可读,命令含真实换行)
  argsJson?: string; // 原始参数(用于"允许并记住"生成规则)
  sensitive?: boolean; // 触及敏感目标(.ssh/.git/凭据…):审批只给 是/否,不提供"始终允许"
  noPersist?: boolean; // 记不成有用规则(复合/一次性命令):也不提供"始终允许"(参考——不为永不再匹配的命令存规则)
}

export type ApprovalDecision = "once" | "session" | "always" | "deny";

// 提示函数:给一批请求,返回每个 id 的决定。注入(命令行/测试各自实现)。
export type ApprovalPrompt = (
  requests: ApprovalRequest[],
) => Promise<Map<string, ApprovalDecision>>;

// 权限裁决(CC 风格):allow 直接放行;ask 弹审批;deny 直接拦截(不执行)。
export type GateDecision = "allow" | "ask" | "deny";

// 审批门:执行器据此对每次调用裁决,并对 ask 的批量请求询问。
export interface ApprovalGate {
  decide(toolName: string, argsJson: string, tool: Tool): GateDecision;
  decideAsync(toolName: string, argsJson: string, tool: Tool): Promise<GateDecision>;
  requestBatch(requests: ApprovalRequest[]): Promise<Map<string, boolean>>;
  // 可选:上一次 requestBatch 里,某个请求 id 最终是被谁批准/拒绝的(分类器自动放行,还是真的弹窗
  // 问了人)。只有真正接了 auto 模式分类器的实现(PermissionGate)需要提供;测试用的假 gate
  // 不实现也没关系(调用方对缺失时应默认按"human"处理,不能默认成"classifier"——宁可高估
  // 打扰次数,不能低估)。只覆盖 requestBatch 分支,规则(decide)直接判的不经过这里。
  lastApprovalSource?(id: string): "classifier" | "human" | undefined;
}
