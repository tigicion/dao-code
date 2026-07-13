import type { ApprovalDecision, ApprovalPrompt, ApprovalRequest } from "./types.js";

// 用注入的 ask(prompt→一行回答)构建审批提示函数,与 REPL 共用同一 stdin。
// isInteractive=false(无 TTY,如 headless/argvPrompt 一次性调用)时直接拒绝、绝不触碰 stdin——
// 曾经不分场景一律尝试读 stdin,在没有真实终端的容器里读行为不稳定(有的请求能读到"关闭"信号
// 立即当空串处理成拒绝,某次却卡住不返回,连 harbor 自己的 timeout 强制取消都没能救回来)。
// 没有人能回答这个问题时,唯一安全、确定性的选择是直接拒绝——不会有更好的答案凭空出现。
export function makeApprovalPrompt(ask: (prompt: string) => Promise<string>, isInteractive: boolean): ApprovalPrompt {
  return async (requests: ApprovalRequest[]) => {
    const out = new Map<string, ApprovalDecision>();
    for (const req of requests) {
      if (!isInteractive) {
        out.set(req.id, "deny");
        continue;
      }
      const ans = (await ask(`\n需要批准:${req.summary}\n  [y]是(允许一次)  [a]始终允许(记住,同类不再问)  [n]否 > `))
        .trim()
        .toLowerCase();
      const decision: ApprovalDecision =
        ans === "y" ? "once" : ans === "a" ? "always" : "deny";
      out.set(req.id, decision);
    }
    return out;
  };
}
