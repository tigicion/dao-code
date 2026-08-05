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
      const hint = req.offerSensitiveAllow
        ? "[y]是(仅本次) [a]开启敏感操作整体放行(除极端危险外不再询问) [n]否"
        : req.sensitive
          ? (req.dangerous
            ? "[y]是(仅本次) [n]否" // 极端危险:子开关开了也仍确认,不提供始终允许
            : "[y]是(仅本次) [a]始终允许(同类不再问) [n]否")
          : "[y]是(允许一次) [a]始终允许(记住,同类不再问) [n]否";
      const ans = (await ask(`\n需要批准:${req.summary}\n  ${hint} > `))
        .trim()
        .toLowerCase();
      // 极端危险命令(dangerous)不接受"始终允许"——提示里没给 [a],按了也当拒绝。
      const decision: ApprovalDecision =
        req.dangerous ? (ans === "y" ? "once" : "deny")
        : ans === "y" ? "once" : ans === "a" ? "always" : "deny";
      out.set(req.id, decision);
    }
    return out;
  };
}
