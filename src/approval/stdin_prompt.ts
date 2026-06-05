import { createInterface } from "node:readline/promises";
import type { ApprovalDecision, ApprovalRequest } from "./types.js";

// 命令行审批提示:逐个请求问 y/s/a/n,返回每个 id 的决定。
// y=本次  s=本会话  a=永久(写入配置)  其它=拒绝
export async function stdinApprovalPrompt(
  requests: ApprovalRequest[],
): Promise<Map<string, ApprovalDecision>> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const out = new Map<string, ApprovalDecision>();
  try {
    for (const req of requests) {
      process.stdout.write(
        `\n需要批准:${req.summary}\n  [y]本次  [s]本会话  [a]永久  [n]拒绝 > `,
      );
      const ans = (await rl.question("")).trim().toLowerCase();
      const decision: ApprovalDecision =
        ans === "y" ? "once" : ans === "s" ? "session" : ans === "a" ? "always" : "deny";
      out.set(req.id, decision);
    }
  } finally {
    rl.close();
  }
  return out;
}
