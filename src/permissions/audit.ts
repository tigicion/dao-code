import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// S3.3 审计轨迹:把写/执行/网络类工具的最终裁决追加到 <工作区>/.dao/audit.log(JSONL),
// 供事后复盘"谁在什么时候被放行/拒绝执行了什么"。DAO_AUDIT=0 可关。best-effort,不抛错。
export interface AuditEntry {
  tool: string;
  capability: string;
  decision: "allow" | "deny";
  summary: string;
}

export function auditDecision(workspaceRoot: string, iso: string, entry: AuditEntry): void {
  if (process.env.DAO_AUDIT === "0") return;
  try {
    const dir = path.join(workspaceRoot, ".dao");
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, "audit.log"), JSON.stringify({ t: iso, ...entry }) + "\n");
  } catch { /* 审计失败不影响主流程 */ }
}
