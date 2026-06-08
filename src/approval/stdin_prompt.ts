import type { ApprovalDecision, ApprovalPrompt, ApprovalRequest } from "./types.js";

// 用注入的 ask(prompt→一行回答)构建审批提示函数,与 REPL 共用同一 stdin。
export function makeApprovalPrompt(ask: (prompt: string) => Promise<string>): ApprovalPrompt {
  return async (requests: ApprovalRequest[]) => {
    const out = new Map<string, ApprovalDecision>();
    for (const req of requests) {
      const ans = (await ask(`\n需要批准:${req.summary}\n  [y]本次  [a]本仓库该类后续都用  [n]拒绝 > `))
        .trim()
        .toLowerCase();
      const decision: ApprovalDecision =
        ans === "y" ? "once" : ans === "a" ? "always" : "deny";
      out.set(req.id, decision);
    }
    return out;
  };
}
