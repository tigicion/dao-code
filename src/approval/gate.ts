import type { Tool } from "../tools/types.js";
import type { ApprovalDecision, ApprovalGate, ApprovalPrompt, ApprovalRequest } from "./types.js";

// 审批按【能力类 capability】(read/write/exec/network/plan)授权,而非按单个工具名:
// 用户批准某个写工具"本仓库后续都用",同类写工具(edit/write 等)一并放行——减少阻塞。
export class SessionApprovalGate implements ApprovalGate {
  private sessionApproved = new Set<string>(); // 本会话已授权的能力类

  constructor(
    private prompt: ApprovalPrompt,
    private alwaysApproved: Set<string>, // 持久化到本仓库的已授权能力类
    private persist: (capability: string) => Promise<void>,
  ) {}

  needsApproval(tool: Tool): boolean {
    return (
      tool.approval !== "auto" &&
      !this.sessionApproved.has(tool.capability) &&
      !this.alwaysApproved.has(tool.capability)
    );
  }

  async requestBatch(requests: ApprovalRequest[]): Promise<Map<string, boolean>> {
    // 同一批按能力类去重:每类挑一个代表问一次,决定应用到该类全部调用。
    const reps = new Map<string, ApprovalRequest>();
    for (const r of requests) if (!reps.has(r.capability)) reps.set(r.capability, r);
    const decisions = await this.prompt([...reps.values()]);
    const capDecision = new Map<string, ApprovalDecision>();
    for (const [cap, rep] of reps) {
      const d = decisions.get(rep.id) ?? "deny";
      capDecision.set(cap, d);
      if (d === "session") this.sessionApproved.add(cap);
      if (d === "always") {
        this.alwaysApproved.add(cap);
        await this.persist(cap);
      }
    }
    const out = new Map<string, boolean>();
    for (const r of requests) out.set(r.id, (capDecision.get(r.capability) ?? "deny") !== "deny");
    return out;
  }
}
