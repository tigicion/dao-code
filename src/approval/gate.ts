import type { Tool } from "../tools/types.js";
import type { ApprovalGate, ApprovalPrompt, ApprovalRequest } from "./types.js";

export class SessionApprovalGate implements ApprovalGate {
  private sessionApproved = new Set<string>();

  constructor(
    private prompt: ApprovalPrompt,
    private alwaysApproved: Set<string>,
    private persist: (toolName: string) => Promise<void>,
  ) {}

  needsApproval(tool: Tool): boolean {
    return (
      tool.approval !== "auto" &&
      !this.sessionApproved.has(tool.name) &&
      !this.alwaysApproved.has(tool.name)
    );
  }

  async requestBatch(requests: ApprovalRequest[]): Promise<Map<string, boolean>> {
    const decisions = await this.prompt(requests);
    const out = new Map<string, boolean>();
    for (const req of requests) {
      const d = decisions.get(req.id) ?? "deny";
      if (d === "session") this.sessionApproved.add(req.toolName);
      if (d === "always") {
        this.alwaysApproved.add(req.toolName);
        await this.persist(req.toolName);
      }
      out.set(req.id, d !== "deny");
    }
    return out;
  }
}
